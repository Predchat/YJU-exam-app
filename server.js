const express  = require('express');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const fetch    = require('node-fetch');

// ── DATA STORAGE (JSON files) ─────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB = {
  _read: (file) => {
    const p = path.join(DATA_DIR, file + '.json');
    if (!fs.existsSync(p)) return [];
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return []; }
  },
  _write: (file, data) => {
    const p = path.join(DATA_DIR, file + '.json');
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  },
  codes: () => DB._read('codes'),
  saveCode: (c) => { const cs = DB.codes(); cs.push(c); DB._write('codes', cs); return c; },
  getCode: (code) => DB.codes().find(c => c.code === code),
  updateCode: (code, upd) => {
    const cs = DB.codes();
    const idx = cs.findIndex(c => c.code === code);
    if (idx >= 0) { cs[idx] = {...cs[idx], ...upd}; DB._write('codes', cs); }
  },
  orders: () => DB._read('orders'),
  saveOrder: (o) => { const os = DB.orders(); os.push({...o, id: Date.now()}); DB._write('orders', os); return o; },
  updateOrder: (id, upd) => {
    const os = DB.orders();
    const idx = os.findIndex(o => o.id === id);
    if (idx >= 0) { os[idx] = {...os[idx], ...upd}; DB._write('orders', os); }
  },
  devices: () => DB._read('devices'),
  getDevice: (fp) => DB.devices().find(d => d.fp === fp),
  saveDevice: (d) => { const ds = DB.devices(); ds.push(d); DB._write('devices', ds); return d; },
  updateDevice: (fp, upd) => {
    const ds = DB.devices();
    const idx = ds.findIndex(d => d.fp === fp);
    if (idx >= 0) { ds[idx] = {...ds[idx], ...upd}; DB._write('devices', ds); }
  },
  rateLimits: () => DB._read('rateLimits'),
  updateRateLimit: (ip, upd) => {
    const rs = DB.rateLimits();
    const idx = rs.findIndex(r => r.ip === ip);
    if (idx >= 0) { rs[idx] = {...rs[idx], ...upd}; DB._write('rateLimits', rs); }
    else { rs.push({ip, ...upd}); DB._write('rateLimits', rs); }
  },
  getRateLimit: (ip) => DB.rateLimits().find(r => r.ip === ip),
};

// ── CONFIG ────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';
const AI_KEY       = process.env.AI_KEY       || '';
const AI_MODEL     = process.env.AI_MODEL     || 'anthropic/claude-haiku-4';
const PORT         = process.env.PORT         || 3001;
const FREE_EXAMS   = 2;
const PACKS = {
  starter: { credits:100, price:5  },
  popular: { credits:300, price:12 },
  power:   { credits:600, price:20 },
};

// ── EXPRESS SETUP ─────────────────────────────────────────
const app = express();

// CORS — BEFORE every route
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin,X-Requested-With,Content-Type,Accept,Authorization,x-admin-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '2mb' }));

// ── HELPERS ───────────────────────────────────────────────
function genCode(pack) {
  const prefix = { starter:'EFS', popular:'EFP', power:'EFW' }[pack] || 'EFX';
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}-${rand.slice(0,4)}-${rand.slice(4,8)}`;
}

function getOrCreateDevice(fp) {
  let dev = DB.getDevice(fp);
  if (!dev) {
    dev = { fp, credits: 0, free_used: 0, created_at: new Date().toISOString(), last_seen: new Date().toISOString() };
    DB.saveDevice(dev);
  } else {
    DB.updateDevice(fp, { last_seen: new Date().toISOString() });
  }
  return dev;
}

function checkRateLimit(ip) {
  let rl = DB.getRateLimit(ip);
  if (!rl) {
    DB.updateRateLimit(ip, { attempts: 1, last_attempt: new Date().toISOString() });
    return { ok: true };
  }
  if (rl.blocked_until && new Date(rl.blocked_until) > new Date()) {
    const mins = Math.ceil((new Date(rl.blocked_until) - new Date()) / 60000);
    return { ok: false, msg: `Too many attempts. Try again in ${mins} minute(s).` };
  }
  if (rl.attempts >= 5) {
    const bu = new Date(Date.now() + 3600000).toISOString();
    DB.updateRateLimit(ip, { blocked_until: bu, attempts: 0 });
    return { ok: false, msg: 'Too many wrong attempts. Try again in 1 hour.' };
  }
  DB.updateRateLimit(ip, { attempts: (rl.attempts || 0) + 1 });
  return { ok: true };
}

function resetRateLimit(ip) {
  DB.updateRateLimit(ip, { attempts: 0, blocked_until: null });
}

function isAdmin(req) {
  return req.headers['x-admin-secret'] === ADMIN_SECRET || req.query.secret === ADMIN_SECRET;
}

function countOnlineDevices() {
  const now = new Date();
  const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);
  return DB.devices().filter(d => new Date(d.last_seen) > fiveMinutesAgo).length;
}

// ── AI CALL (OpenRouter) ──────────────────────────────────
async function callAI(prompt) {
  if (!AI_KEY) throw new Error('AI_KEY not set on server. Contact support.');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + AI_KEY,
      'HTTP-Referer':  'https://examforge.app',
      'X-Title':       'ExamForge',
    },
    body: JSON.stringify({
      model:      AI_MODEL,
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || 'AI error ' + res.status);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

// Health / root
app.get('/',       (req, res) => res.json({ status: 'ExamForge backend running', version: '2.0', freeExams: FREE_EXAMS }));
app.get('/health', (req, res) => res.json({ ok: true }));

// GET /api/status — check credits for a device
app.get('/api/status', (req, res) => {
  const { fp } = req.query;
  if (!fp) return res.status(400).json({ ok: false, msg: 'Missing fp' });
  const dev      = getOrCreateDevice(fp);
  const freeLeft = Math.max(0, FREE_EXAMS - dev.free_used);
  res.json({ ok: true, credits: dev.credits, freeUsed: dev.free_used, freeLeft, freeTotal: FREE_EXAMS });
});

// POST /api/generate — generate exam via AI
app.post('/api/generate', async (req, res) => {
  const { deviceFp, pdfText, subject, numQ, difficulty, qType, language, withExp } = req.body;
  if (!deviceFp || !pdfText || !subject)
    return res.status(400).json({ ok: false, msg: 'Missing required fields.' });
  if (!AI_KEY)
    return res.status(503).json({ ok: false, msg: 'AI service not configured. Contact support.' });

  const dev      = getOrCreateDevice(deviceFp);
  const freeLeft = Math.max(0, FREE_EXAMS - dev.free_used);

  if (freeLeft <= 0 && dev.credits <= 0)
    return res.status(402).json({ ok: false, msg: 'No credits. Please purchase a pack.', needsPurchase: true });

  const typeInstr = {
    multiple_choice: 'All questions must be multiple choice with exactly 4 options labeled A, B, C, D.',
    true_false:      'All questions must be True/False.',
    short_answer:    'All questions must require a short written answer.',
    mixed:           'Mix: about 50% multiple choice, 25% true/false, 25% short answer.',
  }[qType] || 'Mix question types.';

  const prompt = `You are an expert educator. Generate exactly ${numQ || 10} exam questions for subject "${subject}" based on the lesson content below.

REQUIREMENTS:
- Difficulty: ${difficulty || 'medium'}
- ${typeInstr}
- Language: ALL content (questions, options, answers, explanations) MUST be in ${language || 'English'}.
- ${withExp === 'yes' ? 'Include a brief explanation for each answer.' : 'No explanations — set explanation to empty string.'}
- For multiple choice: answer field must be just the letter (A, B, C, or D).
- For true/false: answer field must be exactly "True" or "False".

Return ONLY valid JSON:
{"title":"...","questions":[{"type":"multiple_choice","question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"answer":"A","explanation":"..."},{"type":"true_false","question":"...","options":[],"answer":"True","explanation":"..."},{"type":"short_answer","question":"...","options":[],"answer":"...","explanation":"..."}]}

LESSON:
${pdfText.slice(0, 14000)}`;

  try {
    const raw     = await callAI(prompt);
    const cleaned = raw.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
    const exam    = JSON.parse(cleaned);
    if (!exam.questions?.length) throw new Error('No questions returned.');

    // Deduct credit AFTER successful generation
    if (freeLeft > 0) {
      DB.updateDevice(deviceFp, { free_used: dev.free_used + 1 });
    } else {
      DB.updateDevice(deviceFp, { credits: dev.credits - 1 });
    }

    const updated  = getOrCreateDevice(deviceFp);
    res.json({
      ok:       true,
      exam,
      credits:  updated.credits,
      freeLeft: Math.max(0, FREE_EXAMS - updated.free_used),
    });
  } catch (e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// POST /api/order — save WhatsApp + pack before PayPal
app.post('/api/order', (req, res) => {
  const { whatsapp, pack, deviceFp } = req.body;
  if (!whatsapp || !pack || !PACKS[pack])
    return res.status(400).json({ ok: false, msg: 'Missing fields.' });
  const p = PACKS[pack];
  const o = {
    whatsapp: whatsapp.trim(),
    pack,
    credits: p.credits,
    price_usd: p.price,
    device_fp: deviceFp,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  DB.saveOrder(o);
  res.json({ ok: true, orderId: Date.now() });
});

// POST /api/redeem — validate access code
app.post('/api/redeem', (req, res) => {
  const { code, deviceFp } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!code || !deviceFp) return res.status(400).json({ ok: false, msg: 'Missing code or device.' });

  const rl = checkRateLimit(ip);
  if (!rl.ok) return res.status(429).json({ ok: false, msg: rl.msg });

  const cleaned = code.trim().toUpperCase().replace(/\s/g, '');
  const row     = DB.getCode(cleaned);
  if (!row)            return res.status(404).json({ ok: false, msg: 'Invalid code. Please check and try again.' });
  if (row.status === 'used') return res.status(409).json({ ok: false, msg: 'This code has already been redeemed.' });

  DB.updateCode(cleaned, { status: 'used', redeemed_at: new Date().toISOString(), device_fp: deviceFp });
  const dev        = getOrCreateDevice(deviceFp);
  const newCredits = dev.credits + row.credits;
  DB.updateDevice(deviceFp, { credits: newCredits });
  resetRateLimit(ip);

  res.json({
    ok:       true,
    credits:  newCredits,
    added:    row.credits,
    pack:     row.pack,
    freeLeft: Math.max(0, FREE_EXAMS - dev.free_used),
  });
});

// ═══════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/admin/api/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const orders = DB.orders();
  const codes  = DB.codes();
  res.json({
    ok:           true,
    pending:      orders.filter(o => o.status === 'pending').length,
    sent:         orders.filter(o => o.status === 'sent').length,
    revenue:      orders.filter(o => o.status === 'sent').reduce((s, o) => s + o.price_usd, 0),
    devices:      DB.devices().length,
    online:       countOnlineDevices(),
    credits_used: codes.filter(c => c.status === 'used').reduce((s, c) => s + c.credits, 0),
    total_orders: orders.length,
  });
});

app.get('/admin/api/orders', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const orders = DB.orders();
  const codes  = DB.codes();
  const result = orders.map(o => {
    const code = codes.find(c => c.code === o.code);
    return {...o, code_status: code?.status};
  }).reverse().slice(0, 300);
  res.json({ ok: true, orders: result });
});

app.post('/admin/api/generate-code', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const { pack, orderId } = req.body;
  if (!PACKS[pack]) return res.status(400).json({ ok: false, msg: 'Invalid pack.' });
  const code = genCode(pack);
  const p    = PACKS[pack];
  const c    = {
    code,
    pack,
    credits: p.credits,
    price_usd: p.price,
    status: 'unused',
    created_at: new Date().toISOString(),
  };
  DB.saveCode(c);
  if (orderId) {
    const os = DB.orders();
    const idx = os.findIndex(o => o.id === orderId);
    if (idx >= 0) { os[idx].code = code; os[idx].status = 'code_generated'; DB._write('orders', os); }
  }
  res.json({ ok: true, code, codeId: Date.now(), credits: p.credits });
});

app.post('/admin/api/mark-sent', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const os = DB.orders();
  const idx = os.findIndex(o => o.id === req.body.orderId);
  if (idx >= 0) { os[idx].status = 'sent'; os[idx].sent_at = new Date().toISOString(); DB._write('orders', os); }
  res.json({ ok: true });
});

app.post('/admin/api/verify-payment', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const os = DB.orders();
  const idx = os.findIndex(o => o.id === req.body.orderId);
  if (idx >= 0) { 
    os[idx].verified_at = new Date().toISOString(); 
    DB._write('orders', os); 
  }
  res.json({ ok: true });
});

app.delete('/admin/api/order/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const os = DB.orders();
  DB._write('orders', os.filter(o => o.id !== parseInt(req.params.id)));
  res.json({ ok: true });
});

// ADMIN PAGE — Embedded HTML with interactive buttons
app.get('/admin', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head><title>ExamForge Admin</title></head>
      <body style="font-family:system-ui;padding:40px;background:#0f0f0f;color:#f0ede8;text-align:center;">
        <h1>🔐 Admin Login</h1>
        <p>Enter your admin secret:</p>
        <input type="password" id="secret" placeholder="Admin secret" style="padding:10px;width:200px;font-size:14px;" />
        <button onclick="login()" style="padding:10px 20px;margin-left:10px;background:#e8c97a;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Login</button>
        <script>
          function login() {
            const secret = document.getElementById('secret').value;
            if (secret) window.location = '/admin?secret=' + encodeURIComponent(secret);
          }
          document.getElementById('secret').onkeypress = (e) => { if (e.key === 'Enter') login(); };
        </script>
      </body>
      </html>
    `);
  }

  // Fetch admin data and return dashboard
  const stats = (() => {
    const orders = DB.orders();
    const codes  = DB.codes();
    return {
      pending:      orders.filter(o => o.status === 'pending').length,
      sent:         orders.filter(o => o.status === 'sent').length,
      revenue:      orders.filter(o => o.status === 'sent').reduce((s, o) => s + o.price_usd, 0),
      devices:      DB.devices().length,
      online:       countOnlineDevices(),
      credits_used: codes.filter(c => c.status === 'used').reduce((s, c) => s + c.credits, 0),
      total_orders: orders.length,
    };
  })();

  const orders = DB.orders().reverse().slice(0, 50);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>ExamForge Admin Dashboard</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f0f; color: #f0ede8; padding: 20px; }
        .header { max-width: 1400px; margin: 0 auto 30px; }
        h1 { font-size: 28px; margin-bottom: 10px; }
        .stats { max-width: 1400px; margin: 0 auto 30px; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 15px; }
        .stat-card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 20px; text-align: center; }
        .stat-label { font-size: 11px; color: #999; margin-bottom: 8px; text-transform: uppercase; }
        .stat-value { font-size: 32px; font-weight: 700; color: #e8c97a; }
        .stat-card.online .stat-value { color: #6fcf97; }
        .orders { max-width: 1400px; margin: 0 auto; }
        h2 { margin-bottom: 15px; }
        .order-item { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
        .order-header { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr auto; gap: 15px; align-items: center; margin-bottom: 12px; border-bottom: 1px solid #333; padding-bottom: 12px; }
        .order-field { }
        .order-label { font-size: 10px; color: #999; text-transform: uppercase; margin-bottom: 3px; }
        .order-value { font-size: 14px; font-weight: 500; }
        .status-pending { color: #f0a05a; }
        .status-sent { color: #6fcf97; }
        .order-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; padding-top: 12px; border-top: 1px solid #333; }
        .btn { padding: 8px 14px; background: #e8c97a; color: #1a1208; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all 0.2s; }
        .btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-secondary { background: #333; color: #e8c97a; border: 1px solid #555; }
        .btn-secondary:hover { background: #444; }
        .code-box { background: #222; border: 1px solid #555; border-radius: 5px; padding: 10px 12px; font-family: monospace; font-size: 13px; font-weight: 600; color: #6fcf97; display: inline-block; margin: 0 8px; }
        .message { padding: 12px; border-radius: 5px; margin-bottom: 12px; }
        .message.success { background: rgba(111, 207, 151, 0.2); border: 1px solid rgba(111, 207, 151, 0.4); color: #6fcf97; }
        .message.loading { background: rgba(86, 180, 211, 0.2); border: 1px solid rgba(86, 180, 211, 0.4); color: #56b4d3; }
        .logout { margin-top: 30px; text-align: center; }
        a { color: #e8c97a; text-decoration: none; }
        .empty { color: #999; padding: 40px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>📊 ExamForge Admin Dashboard</h1>
        <p style="color: #999;">Manage orders, generate codes, and monitor activity</p>
      </div>

      <div class="stats">
        <div class="stat-card">
          <div class="stat-label">⏳ Pending</div>
          <div class="stat-value">${stats.pending}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">✅ Sent</div>
          <div class="stat-value">${stats.sent}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">💰 Revenue</div>
          <div class="stat-value">$${stats.revenue.toFixed(2)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">👥 Devices</div>
          <div class="stat-value">${stats.devices}</div>
        </div>
        <div class="stat-card online">
          <div class="stat-label">🟢 Online Now</div>
          <div class="stat-value">${stats.online}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">⚡ Credits</div>
          <div class="stat-value">${stats.credits_used}</div>
        </div>
      </div>

      <div class="orders">
        <h2>📋 All Orders (${orders.length})</h2>
        ${orders.length === 0 ? '<div class="empty">No orders yet</div>' : orders.map(o => `
          <div class="order-item" id="order_${o.id}">
            <div class="order-header">
              <div class="order-field">
                <div class="order-label">WhatsApp</div>
                <div class="order-value">${o.whatsapp}</div>
              </div>
              <div class="order-field">
                <div class="order-label">Pack</div>
                <div class="order-value">${o.pack} (${o.credits} credits)</div>
              </div>
              <div class="order-field">
                <div class="order-label">Price</div>
                <div class="order-value">$${o.price_usd}</div>
              </div>
              <div class="order-field">
                <div class="order-label">Status</div>
                <div class="order-value status-${o.status}">${o.status.toUpperCase()}</div>
              </div>
              <div class="order-field">
                <div class="order-label">Date</div>
                <div class="order-value">${new Date(o.created_at).toLocaleDateString()}</div>
              </div>
            </div>
            <div class="order-actions">
              ${o.status === 'pending' && !o.verified_at ? `
                <button class="btn" style="background:#f0a05a;" onclick="verifyPayment(${o.id})">🔍 Verify Payment</button>
                <button class="btn btn-secondary" style="background:#333;color:#eb5757;border-color:#555;" onclick="deleteOrder(${o.id}, '${o.whatsapp}')">🗑 Delete</button>
                <span style="font-size:11px;color:#999;margin-left:10px;">⚠️ Check PayPal or delete if unpaid</span>
              ` : ''}
              ${o.status === 'pending' && o.verified_at ? `
                <button class="btn" onclick="genCode(${o.id}, '${o.pack}')">⚡ Gen Code</button>
              ` : ''}
              ${o.code ? `
                <div style="display:flex;align-items:center;gap:8px;">
                  <span style="color:#999;">Code:</span>
                  <span class="code-box" id="code_${o.id}">${o.code}</span>
                  <button class="btn btn-secondary" onclick="copyCode(${o.id})">📋 Copy</button>
                  <button class="btn btn-secondary" onclick="sendWhatsApp('${o.whatsapp}', '${o.code}')">💬 Send</button>
                </div>
              ` : ''}
              ${o.status !== 'sent' && o.code ? `
                <button class="btn" onclick="markSent(${o.id})">✅ Mark Sent</button>
              ` : ''}
            </div>
            <div id="msg_${o.id}"></div>
          </div>
        `).join('')}
      </div>

      <div class="logout">
        <a href="/">← Back to app</a>
      </div>

      <script>
        const secret = new URLSearchParams(window.location.search).get('secret');
        
        function showMsg(orderId, msg, type) {
          const el = document.getElementById('msg_' + orderId);
          el.innerHTML = '<div class="message ' + type + '">' + msg + '</div>';
          setTimeout(() => el.innerHTML = '', 3000);
        }

        function genCode(orderId, pack) {
          showMsg(orderId, '⏳ Generating...', 'loading');
          fetch('/admin/api/generate-code', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'x-admin-secret': secret},
            body: JSON.stringify({pack, orderId})
          })
          .then(r => r.json())
          .then(d => {
            if (d.ok) {
              showMsg(orderId, '✅ Code generated: ' + d.code, 'success');
              setTimeout(() => location.reload(), 1500);
            } else {
              showMsg(orderId, '❌ Error: ' + d.msg, 'error');
            }
          })
          .catch(e => showMsg(orderId, '❌ Network error', 'error'));
        }

        function copyCode(orderId) {
          const code = document.getElementById('code_' + orderId).textContent;
          navigator.clipboard.writeText(code).then(() => {
            showMsg(orderId, '✅ Copied!', 'success');
          });
        }

        function sendWhatsApp(wa, code) {
          const msg = 'Your access code is: ' + code;
          window.open('https://wa.me/' + wa.replace(/\D/g, '') + '?text=' + encodeURIComponent(msg), '_blank');
        }

        function markSent(orderId) {
          showMsg(orderId, '⏳ Updating...', 'loading');
          fetch('/admin/api/mark-sent', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'x-admin-secret': secret},
            body: JSON.stringify({orderId})
          })
          .then(r => r.json())
          .then(d => {
            if (d.ok) {
              showMsg(orderId, '✅ Marked as sent!', 'success');
              setTimeout(() => location.reload(), 1500);
            } else {
              showMsg(orderId, '❌ Error', 'error');
            }
          })
          .catch(e => showMsg(orderId, '❌ Network error', 'error'));
        }

        function verifyPayment(orderId) {
          showMsg(orderId, '⏳ Verifying...', 'loading');
          fetch('/admin/api/verify-payment', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'x-admin-secret': secret},
            body: JSON.stringify({orderId})
          })
          .then(r => r.json())
          .then(d => {
            if (d.ok) {
              showMsg(orderId, '✅ Payment verified! Now generate code', 'success');
              setTimeout(() => location.reload(), 1500);
            } else {
              showMsg(orderId, '❌ Error', 'error');
            }
          })
          .catch(e => showMsg(orderId, '❌ Network error', 'error'));
        }

        function deleteOrder(orderId, wa) {
          if (!confirm('Delete order from ' + wa + '? This cannot be undone.')) return;
          showMsg(orderId, '⏳ Deleting...', 'loading');
          fetch('/admin/api/order/' + orderId, {
            method: 'DELETE',
            headers: {'x-admin-secret': secret}
          })
          .then(r => r.json())
          .then(d => {
            if (d.ok) {
              showMsg(orderId, '✅ Order deleted', 'success');
              setTimeout(() => location.reload(), 1000);
            } else {
              showMsg(orderId, '❌ Error deleting', 'error');
            }
          })
          .catch(e => showMsg(orderId, '❌ Network error', 'error'));
        }
      </script>
    </body>
    </html>
  `);
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ ExamForge backend v2.0 running on port ${PORT}`);
  console.log(`📦 AI model: ${AI_MODEL}`);
  console.log(`🔑 AI key configured: ${AI_KEY ? 'YES' : 'NO'}`);
  console.log(`💾 Database: JSON files in ${DATA_DIR}`);
  console.log(`🎁 Free exams per device: ${FREE_EXAMS}`);
});
