const WebSocket = require('ws');
const db = require('./db');
const { executeCopyTrade } = require('./trader');

const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

// Known DEX program IDs we care about
const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const DEX_PROGRAMS = new Set([JUPITER_PROGRAM, RAYDIUM_PROGRAM, PUMP_FUN_PROGRAM]);

class WalletMonitor {
  constructor(broadcast) {
    this.ws = null;
    this.broadcast = broadcast; // function to send updates to dashboard
    this.subscriptions = new Map(); // address -> subscriptionId
    this.reconnectTimer = null;
    this.pingInterval = null;
  }

  getTrackedWallets() {
    return db.prepare('SELECT address FROM wallets WHERE enabled = 1').all().map(r => r.address);
  }

  connect() {
    console.log('[Monitor] Connecting to Helius WebSocket...');

    this.ws = new WebSocket(HELIUS_WS_URL);

    this.ws.on('open', () => {
      console.log('[Monitor] Connected to Helius');
      this.broadcast({ type: 'status', connected: true });
      this.subscribeAll();

      // Keep connection alive
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'getHealth' }));
        }
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        // ignore parse errors
      }
    });

    this.ws.on('close', () => {
      console.log('[Monitor] WebSocket closed, reconnecting in 3s...');
      this.broadcast({ type: 'status', connected: false });
      clearInterval(this.pingInterval);
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', (err) => {
      console.error('[Monitor] WebSocket error:', err.message);
    });
  }

  subscribeAll() {
    const wallets = this.getTrackedWallets();
    wallets.forEach(addr => this.subscribeWallet(addr));
    console.log(`[Monitor] Subscribed to ${wallets.length} wallets`);
  }

  subscribeWallet(address) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.subscriptions.has(address)) return;

    const id = Date.now() + Math.random();
    this.subscriptions.set(address, id);

    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [
        { mentions: [address] },
        { commitment: 'confirmed' }
      ]
    }));

    console.log(`[Monitor] Subscribed to wallet: ${address.slice(0, 8)}...`);
  }

  unsubscribeWallet(address) {
    const subId = this.subscriptions.get(address);
    if (!subId || !this.ws) return;

    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'logsUnsubscribe',
      params: [subId]
    }));

    this.subscriptions.delete(address);
    console.log(`[Monitor] Unsubscribed from: ${address.slice(0, 8)}...`);
  }

  handleMessage(msg) {
    // Ignore subscription confirmations and pings
    if (msg.id || !msg.params) return;

    const result = msg.params?.result;
    if (!result) return;

    const logs = result.value?.logs || [];
    const signature = result.value?.signature;

    // Check if this transaction involves a DEX
    const isDexTx = logs.some(log =>
      [...DEX_PROGRAMS].some(prog => log.includes(prog))
    );

    if (!isDexTx) return;

    // Find which tracked wallet triggered this
    const wallets = this.getTrackedWallets();
    const sourceWallet = wallets.find(addr =>
      logs.some(log => log.includes(addr))
    );

    if (!sourceWallet) return;

    // Determine trade type from logs
    const isBuy = logs.some(log =>
      log.toLowerCase().includes('buy') ||
      log.toLowerCase().includes('swap') && !log.toLowerCase().includes('sell')
    );

    const tradeType = isBuy ? 'buy' : 'sell';

    console.log(`[Monitor] Detected ${tradeType.toUpperCase()} from ${sourceWallet.slice(0,8)}... tx: ${signature}`);

    this.broadcast({
      type: 'trade_detected',
      sourceWallet,
      tradeType,
      signature,
      timestamp: Date.now()
    });

    // Get settings and decide whether to copy
    this.handleTradeDecision(sourceWallet, tradeType, signature, logs);
  }

  async handleTradeDecision(sourceWallet, tradeType, signature, logs) {
    const settings = this.getSettings();

    // Skip sells if filter is on
    if (tradeType === 'sell' && settings.skip_sells === '1') {
      console.log(`[Monitor] Skipping sell — filter active`);
      this.broadcast({
        type: 'trade_skipped',
        reason: 'Sell filter active',
        sourceWallet,
        tradeType
      });

      // Log skipped trade to DB
      db.prepare(`
        INSERT INTO trades (source_wallet, token_mint, token_symbol, type, status)
        VALUES (?, ?, ?, ?, 'skipped')
      `).run(sourceWallet, 'unknown', 'unknown', tradeType);
      return;
    }

    if (settings.bot_active !== '1') {
      console.log('[Monitor] Bot is paused, skipping trade');
      return;
    }

    // Execute the copy trade
    try {
      await executeCopyTrade({
        sourceWallet,
        tradeType,
        signature,
        settings,
        broadcast: this.broadcast.bind(this)
      });
    } catch (err) {
      console.error('[Monitor] Copy trade failed:', err.message);
      this.broadcast({ type: 'trade_error', error: err.message, sourceWallet });
    }
  }

  getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  // Call this when wallets are added/removed from the dashboard
  refresh() {
    const current = new Set(this.subscriptions.keys());
    const active = new Set(this.getTrackedWallets());

    // Subscribe to new wallets
    for (const addr of active) {
      if (!current.has(addr)) this.subscribeWallet(addr);
    }

    // Unsubscribe from removed wallets
    for (const addr of current) {
      if (!active.has(addr)) this.unsubscribeWallet(addr);
    }
  }

  disconnect() {
    clearInterval(this.pingInterval);
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = WalletMonitor;
