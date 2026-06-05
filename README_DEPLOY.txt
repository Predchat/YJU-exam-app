════════════════════════════════════════════
 ExamForge Backend — Deploy to Railway
════════════════════════════════════════════

STEP 1 — Create Railway account
  Go to https://railway.app → Sign up free (GitHub login is easiest)

STEP 2 — Deploy
  Option A (easiest): 
    1. Push the "backend" folder to a GitHub repo
    2. On Railway: New Project → Deploy from GitHub → pick your repo
  
  Option B (drag & drop):
    1. Install Railway CLI: npm install -g @railway/cli
    2. cd into the backend folder
    3. Run: railway login
    4. Run: railway init
    5. Run: railway up

STEP 3 — Set environment variables on Railway
  Go to your project → Variables tab → add these:

    ADMIN_SECRET   = (make up a strong password, e.g. "MyAdmin@2026!")
    PORT           = 3001
    DB_PATH        = /app/examforge.db

STEP 4 — Get your public URL
  Railway gives you a URL like: https://examforge-backend-production.up.railway.app
  Copy this — you need it for the app and admin dashboard.

STEP 5 — Access your admin dashboard
  Open: https://YOUR-RAILWAY-URL/admin
  Enter the ADMIN_SECRET you set above.

STEP 6 — Update the app
  Open app/index.html and find this line near the top:
    const BACKEND_URL = 'https://YOUR-RAILWAY-URL-HERE';
  Replace with your actual Railway URL.

════════════════════════════════════════════
 That's it! Railway free tier = $0/month
════════════════════════════════════════════
