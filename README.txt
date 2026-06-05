═══════════════════════════════════════════
 ExamForge Backend v2.0 — Deploy Guide
═══════════════════════════════════════════

RAILWAY ENVIRONMENT VARIABLES (required):

  ADMIN_SECRET = your-secret-admin-password
  AI_KEY       = sk-or-YOUR-OPENROUTER-KEY
  AI_MODEL     = anthropic/claude-haiku-4
  PORT         = 3001
  DB_PATH      = /app/examforge.db

NOTES:
  - AI_KEY is your OpenRouter API key (sk-or-...)
  - AI_MODEL is the OpenRouter model slug
  - Common model slugs:
      anthropic/claude-haiku-4          (fast, cheap)
      anthropic/claude-sonnet-4         (better quality)
      anthropic/claude-haiku-3-5        (older haiku)
      meta-llama/llama-3.3-70b-instruct:free  (free!)
  - You can change AI_MODEL anytime without redeploying

AFTER DEPLOY:
  1. Copy your Railway URL
  2. Open app/index.html
  3. Find: const BACKEND = 'https://YOUR-RAILWAY-URL-HERE';
  4. Replace with your Railway URL
  5. Re-upload app/ folder to Netlify

ADMIN DASHBOARD:
  https://your-railway-url/admin
  Login with your ADMIN_SECRET
═══════════════════════════════════════════
