require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const routes = require('./routes');
const { handleWebhook } = require('./webhook');

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

app.locals.broadcast = broadcast;

app.post('/webhook/helius', (req, res) => handleWebhook(req, res, broadcast));

const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
setInterval(() => { fetch(`${SELF_URL}/api/status`).catch(() => {}); }, 5 * 60 * 1000);

app.use('/api', routes);
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../public/index.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 SolSnipe running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: ${SELF_URL}/webhook/helius`);
});
