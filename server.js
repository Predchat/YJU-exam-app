const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const path     = require('path');
const fetch    = require('node-fetch');

// ── DATABASE ──────────────────────────────────────────────
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(process.env.DB_PATH || path.join(__dirname, 'examforge.db'));
  db.pragma('journal_mode = WAL');
} catch(e) { console.error('DB error:', e.message); process.exit(1); }

db.exec(`
  CREATE TABLE IF NOT EXISTS codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    pack TEXT NOT NULL,
    credits INTEGER NOT NULL,
    price_usd REAL NOT NULL,
    status TEXT DEFAULT 'unused',
    created_at TEXT DEFAULT (datetime('now')),
    redeemed_at TEXT,
    device_fp TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    whatsapp TEXT NOT NULL,
    pack TEXT NOT NULL,
    credits INTEGER NOT NULL,
    price_usd REAL NOT NULL,
    code_id INTEGER,
    status TEXT DEFAULT 'pending',
    device_fp TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    FOREIGN KEY(code_id) REFERENCES codes(id)
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fp TEXT UNIQUE NOT NULL,
    credits INTEGER DEFAULT 0,
    free_used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    ip TEXT UNIQUE NOT NULL,
    attempts INTEGER DEFAULT 0,
    blocked_until TEXT,
    last_attempt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_fp TEXT,
    pack TEXT,
    tokens_est INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── CONFIG ────────────────────────────────────────────────
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || 'changeme_before_deploy';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || '';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const PORT           = process.env.PORT || 3001;
const FREE_EXAMS     = 2; // 2 free exams per device
const PACKS = {
  starter: { credits:100, price:5   },
  popular: { credits:300, price:12  },
  power:   { credits:600, price:20  },
};

const app = express();
app.use(cors({ origin:'*' }));
app.use(express.json({ limit:'2mb' }));
app.use(express.static(path.join(__dirname,'../admin')));

// ── HELPERS ───────────────────────────────────────────────
function genCode(pack) {
  const prefix = {starter:'EFS',popular:'EFP',power:'EFW'}[pack]||'EFX';
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}-${rand.slice(0,4)}-${rand.slice(4,8)}`;
}
function getOrCreateDevice(fp) {
  let dev = db.prepare('SELECT * FROM devices WHERE fp=?').get(fp);
  if(!dev) {
    db.prepare('INSERT INTO devices (fp) VALUES (?)').run(fp);
    dev = db.prepare('SELECT * FROM devices WHERE fp=?').get(fp);
  } else {
    db.prepare("UPDATE devices SET last_seen=datetime('now') WHERE fp=?").run(fp);
  }
  return dev;
}
function checkRateLimit(ip) {
  let rl = db.prepare('SELECT * FROM rate_limits WHERE ip=?').get(ip);
  if(!rl) { db.prepare('INSERT INTO rate_limits (ip,attempts) VALUES (?,1)').run(ip); return {ok:true}; }
  if(rl.blocked_until && new Date(rl.blocked_until) > new Date()) {
    const mins = Math.ceil((new Date(rl.blocked_until)-new Date())/60000);
    return {ok:false, msg:`Too many attempts. Try again in ${mins} minute(s).`};
  }
  if(rl.attempts >= 5) {
    const bu = new Date(Date.now()+3600000).toISOString();
    db.prepare('UPDATE rate_limits SET blocked_until=?,attempts=0 WHERE ip=?').run(bu,ip);
    return {ok:false, msg:'Too many wrong attempts. Try again in 1 hour.'};
  }
  db.prepare('UPDATE rate_limits SET attempts=attempts+1 WHERE ip=?').run(ip);
  return {ok:true};
}
function resetRateLimit(ip) { db.prepare('UPDATE rate_limits SET attempts=0,blocked_until=NULL WHERE ip=?').run(ip); }
function isAdmin(req) { return req.headers['x-admin-secret']===ADMIN_SECRET || req.query.secret===ADMIN_SECRET; }

// ── AI CALL ───────────────────────────────────────────────
async function callAI(prompt) {
  if(!AI_KEY) throw new Error('AI_KEY not configured on server.');
  // Uses OpenRouter — works with any model including Anthropic via OpenRouter
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + AI_KEY,
      'HTTP-Referer': 'https://examforge.app',
      'X-Title': 'ExamForge',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 4096,
      messages: [{ role:'user', content:prompt }]
    })
  });
  if(!res.ok) {
    const e = await res.json().catch(()=>({}));
    throw new Error(e?.error?.message || 'AI API error '+res.status);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

// ═══════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════

// GET /api/status — device credit check
app.get('/api/status', (req,res) => {
  const { fp } = req.query;
  if(!fp) return res.status(400).json({ok:false,msg:'Missing fp'});
  const dev = getOrCreateDevice(fp);
  const freeLeft = Math.max(0, FREE_EXAMS - dev.free_used);
  res.json({ ok:true, credits:dev.credits, freeUsed:dev.free_used, freeLeft, freeTotal:FREE_EXAMS });
});

// POST /api/generate — generate exam (main action)
app.post('/api/generate', async (req,res) => {
  const { deviceFp, pdfText, subject, numQ, difficulty, qType, language, withExp } = req.body;
  if(!deviceFp||!pdfText||!subject) return res.status(400).json({ok:false,msg:'Missing required fields.'});
  if(!AI_KEY) return res.status(503).json({ok:false,msg:'AI service not configured. Contact support.'});

  const dev = getOrCreateDevice(deviceFp);
  const freeLeft = Math.max(0, FREE_EXAMS - dev.free_used);

  // Check if user can generate
  if(freeLeft <= 0 && dev.credits <= 0) {
    return res.status(402).json({ok:false,msg:'No credits. Please purchase a pack.',needsPurchase:true});
  }

  const typeInstr = {
    multiple_choice: 'All questions must be multiple choice with exactly 4 options labeled A, B, C, D.',
    true_false: 'All questions must be True/False.',
    short_answer: 'All questions must be short answer (1-3 sentences).',
    mixed: 'Mix: about 50% multiple choice, 25% true/false, 25% short answer.',
  }[qType] || 'Mix question types.';

  const prompt = `You are an expert educator. Generate exactly ${numQ||10} exam questions for subject "${subject}" based on the lesson content below.

REQUIREMENTS:
- Difficulty: ${difficulty||'medium'}
- ${typeInstr}
- Language: ALL content (questions, options, answers, explanations) MUST be in ${language||'English'}.
- ${withExp==='yes'?'Include a brief explanation for each answer.':'Do NOT include explanations, set explanation to empty string.'}
- For multiple choice: answer field must be just the letter (A, B, C, or D).
- For true/false: answer field must be exactly "True" or "False".

Return ONLY valid JSON — no markdown, no backticks, no extra text:
{"title":"Descriptive exam title","questions":[{"type":"multiple_choice","question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"answer":"A","explanation":"..."},{"type":"true_false","question":"...","options":[],"answer":"True","explanation":"..."},{"type":"short_answer","question":"...","options":[],"answer":"...","explanation":"..."}]}

LESSON CONTENT:
${pdfText.slice(0,14000)}`;

  try {
    const raw = await callAI(prompt);
    const cleaned = raw.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
    const exam = JSON.parse(cleaned);
    if(!exam.questions?.length) throw new Error('No questions returned.');

    // Deduct credit AFTER successful generation
    if(freeLeft > 0) {
      db.prepare('UPDATE devices SET free_used=free_used+1 WHERE fp=?').run(deviceFp);
    } else {
      db.prepare('UPDATE devices SET credits=credits-1 WHERE fp=?').run(deviceFp);
    }

    // Log usage
    db.prepare('INSERT INTO usage_log (device_fp,pack,tokens_est) VALUES (?,?,?)').run(
      deviceFp, freeLeft>0?'free':'paid', Math.round(pdfText.length/4)
    );

    // Return updated status with exam
    const updatedDev = getOrCreateDevice(deviceFp);
    res.json({
      ok: true,
      exam,
      credits: updatedDev.credits,
      freeLeft: Math.max(0, FREE_EXAMS - updatedDev.free_used),
    });
  } catch(e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ok:false, msg:e.message});
  }
});

// POST /api/order — save order before PayPal
app.post('/api/order', (req,res) => {
  const { whatsapp, pack, deviceFp } = req.body;
  if(!whatsapp||!pack||!PACKS[pack]) return res.status(400).json({ok:false,msg:'Missing fields.'});
  const p = PACKS[pack];
  const id = db.prepare('INSERT INTO orders (whatsapp,pack,credits,price_usd,device_fp) VALUES (?,?,?,?,?)').run(whatsapp.trim(),pack,p.credits,p.price,deviceFp||null).lastInsertRowid;
  res.json({ok:true,orderId:id});
});

// POST /api/redeem — validate and apply access code
app.post('/api/redeem', (req,res) => {
  const { code, deviceFp } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if(!code||!deviceFp) return res.status(400).json({ok:false,msg:'Missing code or device.'});

  const rl = checkRateLimit(ip);
  if(!rl.ok) return res.status(429).json({ok:false,msg:rl.msg});

  const cleaned = code.trim().toUpperCase().replace(/\s/g,'');
  const row = db.prepare('SELECT * FROM codes WHERE code=?').get(cleaned);
  if(!row) return res.status(404).json({ok:false,msg:'Invalid code. Please check and try again.'});
  if(row.status==='used') return res.status(409).json({ok:false,msg:'This code has already been redeemed.'});

  db.prepare("UPDATE codes SET status='used',redeemed_at=datetime('now'),device_fp=? WHERE id=?").run(deviceFp,row.id);
  const dev = getOrCreateDevice(deviceFp);
  const newCredits = dev.credits + row.credits;
  db.prepare('UPDATE devices SET credits=? WHERE fp=?').run(newCredits,deviceFp);
  resetRateLimit(ip);

  res.json({ok:true, credits:newCredits, added:row.credits, pack:row.pack,
    freeLeft: Math.max(0, FREE_EXAMS - dev.free_used)});
});

// ═══════════════════════════════════════════════════════════
//  ADMIN API
// ═══════════════════════════════════════════════════════════
app.get('/admin/api/stats', (req,res) => {
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  res.json({ok:true,
    pending:   db.prepare("SELECT COUNT(*) n FROM orders WHERE status='pending'").get().n,
    sent:      db.prepare("SELECT COUNT(*) n FROM orders WHERE status='sent'").get().n,
    revenue:   db.prepare("SELECT COALESCE(SUM(price_usd),0) s FROM orders WHERE status='sent'").get().s,
    devices:   db.prepare('SELECT COUNT(*) n FROM devices').get().n,
    credits:   db.prepare("SELECT COALESCE(SUM(credits),0) s FROM codes WHERE status='used'").get().s,
    total_orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
  });
});

app.get('/admin/api/orders', (req,res) => {
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  const orders = db.prepare(`
    SELECT o.*, c.code, c.status AS code_status
    FROM orders o LEFT JOIN codes c ON o.code_id=c.id
    ORDER BY o.created_at DESC LIMIT 300
  `).all();
  res.json({ok:true, orders});
});

app.post('/admin/api/generate-code', (req,res) => {
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  const {pack, orderId} = req.body;
  if(!PACKS[pack]) return res.status(400).json({ok:false,msg:'Invalid pack.'});
  const code = genCode(pack);
  const p = PACKS[pack];
  const codeId = db.prepare('INSERT INTO codes (code,pack,credits,price_usd) VALUES (?,?,?,?)').run(code,pack,p.credits,p.price).lastInsertRowid;
  if(orderId) db.prepare("UPDATE orders SET code_id=?,status='code_generated' WHERE id=?").run(codeId,orderId);
  res.json({ok:true, code, codeId, credits:p.credits});
});

app.post('/admin/api/mark-sent', (req,res) => {
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  db.prepare("UPDATE orders SET status='sent',sent_at=datetime('now') WHERE id=?").run(req.body.orderId);
  res.json({ok:true});
});

app.delete('/admin/api/order/:id', (req,res) => {
  if(!isAdmin(req)) return res.status(403).json({ok:false});
  db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'../admin/index.html')));
app.get('/', (req,res) => res.json({status:'ExamForge backend v2.0 running', freeExams:FREE_EXAMS}));

app.listen(PORT, () => console.log(`ExamForge backend v2.0 on port ${PORT}`));
