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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const wss = new WebSocket.Server({ server, path: '/ws' });
const dashboardClients = new Set();

wss.on('connection', (ws) => {
  console.log('[WS] Dashboard client connected');
  dashboardClients.add(ws);
  ws.on('close', () => { dashboardClients.delete(ws); });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
setInterval(() => { fetch(`${SELF_URL}/api/status`).catch(() => {}); }, 5 * 60 * 1000);

const monitor = new WalletMonitor(broadcast);
app.locals.monitor = monitor;

if (!process.env.HELIUS_API_KEY || process.env.HELIUS_API_KEY === 'your_helius_api_key_here') {
  console.warn('[⚠️] HELIUS_API_KEY not set');
} else {
  monitor.connect();
}

app.use('/api', routes);
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../public/index.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 SolSnipe running on port ${PORT}`); });
process.on('SIGTERM', () => { monitor.disconnect(); server.close(() => process.exit(0)); });
