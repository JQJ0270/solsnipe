const WebSocket = require('ws');
const db = require('./db');
const { executeCopyTrade } = require('./trader');
const { executePaperTrade } = require('./paper');

const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
]);

class WalletMonitor {
  constructor(broadcast) {
    this.ws = null;
    this.broadcast = broadcast;
    this.subscriptions = new Map();
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.trackedWallets = [];
  }

  async loadWallets() {
    const rows = await db.all_p('SELECT address FROM wallets WHERE enabled = 1');
    this.trackedWallets = rows.map(r => r.address);
    return this.trackedWallets;
  }

  connect() {
    console.log('[Monitor] Connecting to Helius WebSocket...');
    this.ws = new WebSocket(HELIUS_WS_URL);

    this.ws.on('open', async () => {
      console.log('[Monitor] Connected to Helius');
      this.broadcast({ type: 'status', connected: true });
      await this.subscribeAll();
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'getHealth' }));
        }
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try { this.handleMessage(JSON.parse(data.toString())); } catch {}
    });

    this.ws.on('close', () => {
      console.log('[Monitor] Disconnected, reconnecting in 3s...');
      this.broadcast({ type: 'status', connected: false });
      clearInterval(this.pingInterval);
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', (err) => console.error('[Monitor] WS error:', err.message));
  }

  async subscribeAll() {
    const wallets = await this.loadWallets();
    wallets.forEach(addr => this.subscribeWallet(addr));
    console.log(`[Monitor] Subscribed to ${wallets.length} wallets`);
  }

  subscribeWallet(address) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.subscriptions.has(address)) return;
    const id = Date.now() + Math.random();
    this.subscriptions.set(address, id);
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id,
      method: 'logsSubscribe',
      params: [{ mentions: [address] }, { commitment: 'confirmed' }]
    }));
    console.log(`[Monitor] Subscribed: ${address.slice(0,8)}...`);
  }

  unsubscribeWallet(address) {
    const subId = this.subscriptions.get(address);
    if (!subId || !this.ws) return;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'logsUnsubscribe', params: [subId] }));
    this.subscriptions.delete(address);
  }

  handleMessage(msg) {
    if (msg.id || !msg.params) return;
    const result = msg.params?.result;
    if (!result) return;
    const logs = result.value?.logs || [];
    const signature = result.value?.signature;

    console.log(`[DEBUG] Received tx: ${signature}, logs count: ${logs.length}`);
    console.log(`[DEBUG] Tracked wallets: ${this.trackedWallets.join(', ')}`);

    const sourceWallet = this.trackedWallets.find(addr => logs.some(log => log.includes(addr)));
    if (!sourceWallet) {
      console.log(`[DEBUG] No matching wallet found in logs`);
      return;
    }
    console.log(`[DEBUG] Matched wallet: ${sourceWallet}`);

const isDexTx = logs.some(log => [...DEX_PROGRAMS].some(prog => log.includes(prog)));
const hasTransfer = logs.some(log => log.includes('Transfer') || log.includes('transfer'));
if (!isDexTx && !hasTransfer) return;

const isBuy = logs.some(log =>
  log.toLowerCase().includes('buy') ||
  log.toLowerCase().includes('swap') ||
  log.toLowerCase().includes('mint')
);
const tradeType = isBuy ? 'buy' : 'sell';

    console.log(`[Monitor] ${tradeType.toUpperCase()} detected from ${sourceWallet.slice(0,8)}...`);
    this.broadcast({ type: 'trade_detected', sourceWallet, tradeType, signature, timestamp: Date.now() });
    this.handleTradeDecision(sourceWallet, tradeType, signature, logs);
  }

  async handleTradeDecision(sourceWallet, tradeType, signature, logs) {
    const rows = await db.all_p('SELECT key, value FROM settings');
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));

    if (tradeType === 'sell' && settings.skip_sells === '1') {
      this.broadcast({ type: 'trade_skipped', reason: 'Sell filter active', sourceWallet, tradeType });
      await db.run_p(`INSERT INTO trades (source_wallet, token_mint, token_symbol, type, status) VALUES (?, ?, ?, ?, 'skipped')`,
        [sourceWallet, 'unknown', 'unknown', tradeType]);
      return;
    }

    if (settings.bot_active !== '1') return;

    if (settings.paper_mode === '1') {
      console.log('[Monitor] Paper mode — simulating trade');
      try {
        await executePaperTrade({
          sourceWallet, tradeType,
          tokenMint: 'unknown',
          tokenSymbol: 'TOKEN',
          settings,
          broadcast: this.broadcast.bind(this)
        });
      } catch (err) {
        console.error('[Monitor] Paper trade failed:', err.message);
      }
      return;
    }

    try {
      await executeCopyTrade({ sourceWallet, tradeType, signature, settings, broadcast: this.broadcast.bind(this) });
    } catch (err) {
      console.error('[Monitor] Copy trade failed:', err.message);
      this.broadcast({ type: 'trade_error', error: err.message, sourceWallet });
    }
  }

  async refresh() {
    const current = new Set(this.subscriptions.keys());
    const active = new Set(await this.loadWallets());
    for (const addr of active) { if (!current.has(addr)) this.subscribeWallet(addr); }
    for (const addr of current) { if (!active.has(addr)) this.unsubscribeWallet(addr); }
  }

  disconnect() {
    clearInterval(this.pingInterval);
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = WalletMonitor;
