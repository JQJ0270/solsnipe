require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');
const path      = require('path');

const WalletMonitor = require('./monitor');
const Trader        = require('./trader');
const CopyEngine    = require('./copyEngine');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── WebSocket server for dashboard real-time updates ──────
const wss = new WebSocket.Server({ noServer: true });
const dashboardClients = new Set();

wss.on('connection', (ws) => {
  dashboardClients.add(ws);
  console.log('[Server] Dashboard connected. Clients:', dashboardClients.size);
  ws.on('close', () => dashboardClients.delete(ws));
});

function broadcastToDashboard(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ── Init core modules ──────────────────────────────────────
let trader      = null;
let monitor     = null;
let copyEngine  = null;

function initBot() {
  const { HELIUS_RPC_URL, HELIUS_WS_URL, WALLET_PRIVATE_KEY } = process.env;

  if (!HELIUS_RPC_URL || !WALLET_PRIVATE_KEY || WALLET_PRIVATE_KEY === 'your_base58_private_key_here') {
    console.log('[Server] Wallet not configured yet — running in preview mode');
    return;
  }

  try {
    trader     = new Trader(HELIUS_RPC_URL, WALLET_PRIVATE_KEY);
    copyEngine = new CopyEngine(trader, broadcastToDashboard);
    monitor    = new WalletMonitor(HELIUS_WS_URL, (event) => copyEngine.handleDetectedTrade(event));
    monitor.connect();
    console.log('[Server] Bot engine started');
  } catch (err) {
    console.error('[Server] Failed to start bot:', err.message);
  }
}

// ── REST API ───────────────────────────────────────────────

// Status
app.get('/api/status', (req, res) => {
  res.json({
    botReady:    !!trader,
    connected:   monitor?.getStatus()?.connected || false,
    walletPubkey: trader?.publicKey || null,
    uptime:      process.uptime()
  });
});

// Wallets
app.get('/api/wallets', (req, res) => {
  res.json(monitor?.getStatus()?.wallets || []);
});

app.post('/api/wallets', (req, res) => {
  const { address, name } = req.body;
  if (!address || address.length < 32) return res.status(400).json({ error: 'Invalid address' });
  monitor?.addWallet(address, { name });
  res.json({ success: true, address });
});

app.delete('/api/wallets/:address', (req, res) => {
  monitor?.removeWallet(req.params.address);
  res.json({ success: true });
});

app.patch('/api/wallets/:address', (req, res) => {
  const { enabled } = req.body;
  monitor?.setEnabled(req.params.address, enabled);
  res.json({ success: true });
});

// Filters
app.get('/api/filters', (req, res) => {
  res.json(copyEngine?.getFilters() || {});
});

app.post('/api/filters', (req, res) => {
  copyEngine?.setFilters(req.body);
  res.json({ success: true, filters: copyEngine?.getFilters() });
});

// Trade log
app.get('/api/trades', (req, res) => {
  res.json(copyEngine?.getTradeLog() || []);
});

// Positions
app.get('/api/positions', (req, res) => {
  res.json(copyEngine?.getPositions() || []);
});

// Balance
app.get('/api/balance', async (req, res) => {
  if (!trader) return res.json({ sol: 0 });
  const sol = await trader.getSOLBalance();
  res.json({ sol });
});

// Configure wallet (called from dashboard setup)
app.post('/api/configure', (req, res) => {
  // In production, write to .env securely
  // For now just reinit
  res.json({ success: true, message: 'Set WALLET_PRIVATE_KEY in your .env file and restart' });
});

// ── Start server ──────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[Server] SolSnipe running on http://localhost:${PORT}`);
  initBot();
});

// Upgrade HTTP to WebSocket
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
});
