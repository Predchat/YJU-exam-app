═══════════════════════════════════════════════════════════════════════════════
 ExamForge Backend v2.0 — Deploy Guide
═══════════════════════════════════════════════════════════════════════════════

QUICK START:
━━━━━━━━━━━
1. Upload backend/ to your GitHub repo (or connect to Railway directly)
2. Railway will auto-deploy
3. Get your Railway URL from dashboard
4. Open app/index.html, update BACKEND constant with your URL
5. Re-upload app/ to Netlify
6. Done! Server should stay running now.

RAILWAY ENVIRONMENT VARIABLES (required):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ADMIN_SECRET = your-secret-admin-password
  AI_KEY       = sk-or-YOUR-OPENROUTER-KEY
  AI_MODEL     = anthropic/claude-haiku-4

Optional:
  PORT         = 3001 (default)
  DATA_DIR     = /app/data (where JSON files are stored)

COMMON AI MODELS:
━━━━━━━━━━━━━━━
  anthropic/claude-haiku-4     ← fast + cheap (recommended)
  anthropic/claude-sonnet-4    ← better quality
  meta-llama/llama-3.3-70b     ← free option
  mixtral-8x7b-instruct        ← balanced

DATABASE:
━━━━━━━━━
Data stored as JSON files in /app/data/:
  - codes.json       (access codes)
  - orders.json      (payment orders)
  - devices.json     (user devices + credits)
  - rateLimits.json  (rate limit tracking)

DEPLOYMENT NOTES:
━━━━━━━━━━━━━━━━
- No native modules needed (instant deploy!)
- Health check available at GET /
- Admin dashboard at GET /admin
- All routes support CORS

ADMIN DASHBOARD:
━━━━━━━━━━━━━━━
  https://your-railway-url/admin?secret=YOUR_ADMIN_SECRET

═══════════════════════════════════════════════════════════════════════════════
