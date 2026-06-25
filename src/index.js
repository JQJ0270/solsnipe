require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const routes = require('./routes');
const WalletMonitor = require('./monitor');

const app = express();
const server = http.createServer(app);

// ─── MIDDLEWARE ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── WEBSOCKET SERVER (live updates to dashboard) ───────────
const wss = new WebSocket.Server({ server, path: '/ws' });
const dashboardClients = new Set();

wss.on('connection', (ws) => {
  console.log('[WS] Dashboard client connected');
  dashboardClients.add(ws);

  ws.on('close', () => {
    dashboardClients.delete(ws);
    console.log('[WS] Dashboard client disconnected');
  });
});

// Broadcast to all connected dashboard tabs
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ─── WALLET MONITOR ─────────────────────────────────────────
const monitor = new WalletMonitor(broadcast);
app.locals.monitor = monitor;

// Validate env vars before starting monitor
if (!process.env.HELIUS_API_KEY || process.env.HELIUS_API_KEY === 'your_helius_api_key_here') {
  console.warn('[⚠️] HELIUS_API_KEY not set — monitor will not start');
  console.warn('[⚠️] Set your API key in Railway environment variables');
} else {
  monitor.connect();
}

if (!process.env.WALLET_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY === 'your_phantom_private_key_here') {
  console.warn('[⚠️] WALLET_PRIVATE_KEY not set — copy trading will not work');
  console.warn('[⚠️] Set your private key in Railway environment variables');
}

// ─── API ROUTES ─────────────────────────────────────────────
app.use('/api', routes);

// Catch-all: serve dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── START SERVER ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 SolSnipe running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`🌐 API:       http://localhost:${PORT}/api\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  monitor.disconnect();
  server.close(() => process.exit(0));
});
