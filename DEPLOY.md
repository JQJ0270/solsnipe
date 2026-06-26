# SolSnipe — Deploy to Railway (Free)

## Step 1 — Push to GitHub
1. Go to github.com → New repository → name it `solsnipe` → Create
2. Download GitHub Desktop from desktop.github.com
3. Clone your new repo, drag the solsnipe folder contents into it, commit & push

## Step 2 — Deploy on Railway
1. Go to railway.app → Login with GitHub
2. Click "New Project" → "Deploy from GitHub repo" → select `solsnipe`
3. Railway will auto-detect Node.js and deploy

## Step 3 — Add Environment Variables
In Railway dashboard → your project → Variables tab, add:
```
HELIUS_API_KEY        = your_key_here
HELIUS_RPC_URL        = https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS_URL         = wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_PRIVATE_KEY    = your_phantom_private_key
PORT                  = 3001
```

## Step 4 — Get your live URL
Railway gives you a public URL like:
`https://solsnipe-production.up.railway.app`

Open that URL from anywhere in the world — that's your dashboard!

## Security Notes
- NEVER share your WALLET_PRIVATE_KEY with anyone
- Only fund the trading wallet with what you're willing to risk
- Start with small copy amounts (0.1 SOL) to test first
