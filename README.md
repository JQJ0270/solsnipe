# SolSnipe — Solana Copy Trading Bot

A web-based Solana meme coin copy trading dashboard. Add wallets from anywhere, copy trades at low latency.

## 🚀 Deploy to Railway (Free)

### Step 1 — Push to GitHub
1. Create a new repo on github.com (call it `solsnipe`)
2. Upload all these files to it

### Step 2 — Deploy on Railway
1. Go to **railway.app** and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `solsnipe` repo
4. Railway will auto-detect Node.js and deploy

### Step 3 — Add Environment Variables
In Railway dashboard → your project → **Variables**, add:

| Key | Value |
|-----|-------|
| `HELIUS_API_KEY` | Your Helius API key |
| `WALLET_PRIVATE_KEY` | Your Phantom private key (base58) |
| `DEFAULT_COPY_AMOUNT_SOL` | `0.25` |
| `DEFAULT_SLIPPAGE_BPS` | `1500` |
| `MIN_TRADE_SOL` | `0.1` |
| `MAX_TRADE_SOL` | `5` |
| `MIN_TOKEN_AGE_SECONDS` | `30` |
| `AUTO_SELL_MULTIPLIER` | `2` |

### Step 4 — Get your URL
Railway gives you a public URL like `https://solsnipe-production.up.railway.app`
Open it from any browser, anywhere in the world ✅

## 🔑 Getting Your Phantom Private Key
1. Open Phantom wallet
2. Click the menu (≡) → Settings
3. Select your wallet → Export Private Key
4. Enter your password
5. Copy the key → paste into Railway `WALLET_PRIVATE_KEY`

⚠️ **Never share your private key with anyone. Never commit it to GitHub.**

## 📁 Project Structure
```
solsnipe/
├── src/
│   ├── index.js      # Main server entry point
│   ├── monitor.js    # Helius WebSocket wallet monitor
│   ├── trader.js     # Jupiter swap executor
│   ├── routes.js     # REST API endpoints
│   └── db.js         # SQLite database
├── public/
│   └── index.html    # Dashboard UI
├── package.json
├── .env.example      # Copy to .env for local dev
└── .gitignore        # Keeps .env out of GitHub
```

## 🛠 Local Development
```bash
npm install
cp .env.example .env
# Fill in your keys in .env
npm run dev
# Open http://localhost:3000
```
