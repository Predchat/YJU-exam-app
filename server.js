const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

// ── DATABASE SETUP ───────────────────────────────────────────────────────────
let db;
try {
  const Database = require('better-sqlite3');
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'examforge.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
} catch(e) {
  console.error('SQLite error:', e.message);
  process.exit(1);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT UNIQUE NOT NULL,
    pack        TEXT NOT NULL,
    credits     INTEGER NOT NULL,
    price_usd   REAL NOT NULL,
    status      TEXT DEFAULT 'unused',
    created_at  TEXT DEFAULT (datetime('now')),
    redeemed_at TEXT,
    device_fp   TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    whatsapp      TEXT NOT NULL,
    pack          TEXT NOT NULL,
    credits       INTEGER NOT NULL,
    price_usd     REAL NOT NULL,
    code_id       INTEGER,
    status        TEXT DEFAULT 'pending',
    device_fp     TEXT,
    note          TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    sent_at       TEXT,
    FOREIGN KEY(code_id) REFERENCES codes(id)
  );
  CREATE TABLE IF NOT EXISTS devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fp          TEXT UNIQUE NOT NULL,
    credits     INTEGER DEFAULT 0,
    free_used   INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    last_seen   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    ip          TEXT NOT NULL,
    attempts    INTEGER DEFAULT 0,
    blocked_until TEXT,
    last_attempt  TEXT DEFAULT (datetime('now'))
  );
`);

// ── CONFIG ───────────────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme_before_deploy';
const PORT         = process.env.PORT || 3001;
const PACKS = {
  starter: { credits: 100,  price: 5  },
  popular: { credits: 300,  price: 12 },
  power:   { credits: 600,  price: 20 },
};

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../admin')));

// ── HELPERS ──────────────────────────────────────────────────────────────────
function genCode(pack) {
  const prefix = { starter: 'EFS', popular: 'EFP', power: 'EFW' }[pack] || 'EFX';
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}-${rand.slice(0,4)}-${rand.slice(4,8)}`;
}
function getOrCreateDevice(fp) {
  let dev = db.prepare('SELECT * FROM devices WHERE fp=?').get(fp);
  if (!dev) {
    db.prepare('INSERT INTO devices (fp) VALUES (?)').run(fp);
    dev = db.prepare('SELECT * FROM devices WHERE fp=?').get(fp);
  } else {
    db.prepare("UPDATE devices SET last_seen=datetime('now') WHERE fp=?").run(fp);
  }
  return dev;
}
function checkRateLimit(ip) {
  const now = new Date().toISOString();
  let rl = db.prepare('SELECT * FROM rate_limits WHERE ip=?').get(ip);
  if (!rl) {
    db.prepare('INSERT INTO rate_limits (ip, attempts) VALUES (?,1)').run(ip);
    return { ok: true };
  }
  if (rl.blocked_until && new Date(rl.blocked_until) > new Date()) {
    const mins = Math.ceil((new Date(rl.blocked_until) - new Date()) / 60000);
    return { ok: false, msg: `Too many attempts. Try again in ${mins} minute(s).` };
  }
  if (rl.attempts >= 5) {
    const blockedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE rate_limits SET blocked_until=?, attempts=0 WHERE ip=?').run(blockedUntil, ip);
    return { ok: false, msg: 'Too many wrong attempts. Blocked for 1 hour.' };
  }
  db.prepare('UPDATE rate_limits SET attempts=attempts+1, last_attempt=? WHERE ip=?').run(now, ip);
  return { ok: true };
}
function resetRateLimit(ip) {
  db.prepare('UPDATE rate_limits SET attempts=0, blocked_until=NULL WHERE ip=?').run(ip);
}
function isAdmin(req) {
  return req.headers['x-admin-secret'] === ADMIN_SECRET ||
         req.query.secret === ADMIN_SECRET;
}

// ═══════════════════════════════════════════════════════════
//  PUBLIC API  (used by the app)
// ═══════════════════════════════════════════════════════════

// POST /api/order — user submits whatsapp + pack before paying
app.post('/api/order', (req, res) => {
  const { whatsapp, pack, deviceFp } = req.body;
  if (!whatsapp || !pack || !PACKS[pack])
    return res.status(400).json({ ok: false, msg: 'Missing fields.' });
  const p = PACKS[pack];
  const orderId = db.prepare(
    'INSERT INTO orders (whatsapp, pack, credits, price_usd, device_fp) VALUES (?,?,?,?,?)'
  ).run(whatsapp.trim(), pack, p.credits, p.price, deviceFp || null).lastInsertRowid;
  res.json({ ok: true, orderId });
});

// POST /api/redeem — user enters code, server validates
app.post('/api/redeem', (req, res) => {
  const { code, deviceFp } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  if (!code || !deviceFp)
    return res.status(400).json({ ok: false, msg: 'Missing code or device.' });

  // Rate limit
  const rl = checkRateLimit(ip);
  if (!rl.ok) return res.status(429).json({ ok: false, msg: rl.msg });

  const cleaned = code.trim().toUpperCase().replace(/\s/g, '');
  const row = db.prepare('SELECT * FROM codes WHERE code=?').get(cleaned);

  if (!row) return res.status(404).json({ ok: false, msg: 'Invalid code. Please check and try again.' });
  if (row.status === 'used') return res.status(409).json({ ok: false, msg: 'This code has already been redeemed.' });

  // Mark code used
  db.prepare("UPDATE codes SET status='used', redeemed_at=datetime('now'), device_fp=? WHERE id=?").run(deviceFp, row.id);

  // Add credits to device
  const dev = getOrCreateDevice(deviceFp);
  const newCredits = dev.credits + row.credits;
  db.prepare('UPDATE devices SET credits=? WHERE fp=?').run(newCredits, deviceFp);

  // Reset rate limit on success
  resetRateLimit(ip);

  res.json({ ok: true, credits: newCredits, added: row.credits, pack: row.pack });
});

// GET /api/credits — app checks current credit balance
app.get('/api/credits', (req, res) => {
  const { fp } = req.query;
  if (!fp) return res.status(400).json({ ok: false });
  const dev = getOrCreateDevice(fp);
  res.json({ ok: true, credits: dev.credits, freeUsed: !!dev.free_used });
});

// POST /api/use-free — mark free exam used on server
app.post('/api/use-free', (req, res) => {
  const { deviceFp } = req.body;
  if (!deviceFp) return res.status(400).json({ ok: false });
  const dev = getOrCreateDevice(deviceFp);
  if (dev.free_used) return res.json({ ok: false, msg: 'Free exam already used.' });
  db.prepare('UPDATE devices SET free_used=1 WHERE fp=?').run(deviceFp);
  res.json({ ok: true });
});

// POST /api/use-credit — deduct 1 credit from device
app.post('/api/use-credit', (req, res) => {
  const { deviceFp } = req.body;
  if (!deviceFp) return res.status(400).json({ ok: false });
  const dev = getOrCreateDevice(deviceFp);
  if (dev.credits <= 0) return res.status(402).json({ ok: false, msg: 'No credits.' });
  db.prepare('UPDATE devices SET credits=credits-1 WHERE fp=?').run(deviceFp);
  res.json({ ok: true, credits: dev.credits - 1 });
});

// ═══════════════════════════════════════════════════════════
//  ADMIN API  (protected by ADMIN_SECRET header)
// ═══════════════════════════════════════════════════════════

// GET /admin/api/orders — all pending orders
app.get('/admin/api/orders', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, msg: 'Forbidden' });
  const orders = db.prepare(`
    SELECT o.*, c.code, c.status as code_status
    FROM orders o
    LEFT JOIN codes c ON o.code_id = c.id
    ORDER BY o.created_at DESC LIMIT 200
  `).all();
  res.json({ ok: true, orders });
});

// POST /admin/api/generate-code — generate a code and assign to order
app.post('/admin/api/generate-code', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, msg: 'Forbidden' });
  const { pack, orderId } = req.body;
  if (!pack || !PACKS[pack]) return res.status(400).json({ ok: false, msg: 'Invalid pack.' });
  const p = PACKS[pack];
  const code = genCode(pack);
  const codeId = db.prepare(
    'INSERT INTO codes (code, pack, credits, price_usd) VALUES (?,?,?,?)'
  ).run(code, pack, p.credits, p.price).lastInsertRowid;
  if (orderId) {
    db.prepare("UPDATE orders SET code_id=?, status='code_generated' WHERE id=?").run(codeId, orderId);
  }
  res.json({ ok: true, code, codeId, credits: p.credits });
});

// POST /admin/api/mark-sent — mark order as code sent
app.post('/admin/api/mark-sent', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, msg: 'Forbidden' });
  const { orderId } = req.body;
  db.prepare("UPDATE orders SET status='sent', sent_at=datetime('now') WHERE id=?").run(orderId);
  res.json({ ok: true });
});

// GET /admin/api/stats — dashboard stats
app.get('/admin/api/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, msg: 'Forbidden' });
  const totalOrders   = db.prepare("SELECT COUNT(*) as n FROM orders").get().n;
  const pending       = db.prepare("SELECT COUNT(*) as n FROM orders WHERE status='pending'").get().n;
  const sent          = db.prepare("SELECT COUNT(*) as n FROM orders WHERE status='sent'").get().n;
  const totalRevenue  = db.prepare("SELECT SUM(price_usd) as s FROM orders WHERE status='sent'").get().s || 0;
  const totalCredits  = db.prepare("SELECT SUM(credits) as s FROM codes WHERE status='used'").get().s || 0;
  const totalDevices  = db.prepare("SELECT COUNT(*) as n FROM devices").get().n;
  res.json({ ok: true, totalOrders, pending, sent, totalRevenue, totalCredits, totalDevices });
});

// DELETE /admin/api/order/:id
app.delete('/admin/api/order/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, msg: 'Forbidden' });
  db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// GET /admin — serve admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});
app.get('/', (req, res) => {
  res.json({ status: 'ExamForge backend running', version: '1.0.0' });
});

app.listen(PORT, () => console.log(`ExamForge backend running on port ${PORT}`));
