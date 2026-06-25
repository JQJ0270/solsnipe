const express = require('express');
const router = express.Router();
const db = require('./db');
const { getWalletBalance } = require('./trader');

// ─── WALLETS ───────────────────────────────────────────────

// GET all wallets
router.get('/wallets', (req, res) => {
  const wallets = db.prepare('SELECT * FROM wallets ORDER BY created_at DESC').all();
  res.json(wallets);
});

// POST add a wallet
router.post('/wallets', (req, res) => {
  const { address, label } = req.body;
  if (!address || address.length < 32) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }
  try {
    db.prepare('INSERT INTO wallets (address, label) VALUES (?, ?)').run(address, label || null);
    const wallet = db.prepare('SELECT * FROM wallets WHERE address = ?').get(address);
    // Tell monitor to subscribe to this wallet
    req.app.locals.monitor?.refresh();
    res.json(wallet);
  } catch (e) {
    res.status(409).json({ error: 'Wallet already exists' });
  }
});

// PATCH toggle wallet enabled/disabled
router.patch('/wallets/:id', (req, res) => {
  const { enabled, label } = req.body;
  const { id } = req.params;

  if (enabled !== undefined) {
    db.prepare('UPDATE wallets SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }
  if (label !== undefined) {
    db.prepare('UPDATE wallets SET label = ? WHERE id = ?').run(label, id);
  }

  req.app.locals.monitor?.refresh();
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
  res.json(wallet);
});

// DELETE a wallet
router.delete('/wallets/:id', (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM wallets WHERE id = ?').run(req.params.id);
  req.app.locals.monitor?.refresh();
  res.json({ success: true });
});

// ─── TRADES ────────────────────────────────────────────────

// GET recent trades
router.get('/trades', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const trades = db.prepare(`
    SELECT * FROM trades ORDER BY created_at DESC LIMIT ?
  `).all(limit);
  res.json(trades);
});

// GET PnL summary
router.get('/pnl', (req, res) => {
  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as copied,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      COALESCE(SUM(pnl_usd), 0) as total_pnl_usd
    FROM trades
  `).get();

  const byToken = db.prepare(`
    SELECT token_symbol, token_mint, type, amount_sol, pnl_usd, status, created_at
    FROM trades
    ORDER BY created_at DESC
    LIMIT 20
  `).all();

  res.json({ summary, byToken });
});

// ─── SETTINGS ──────────────────────────────────────────────

// GET all settings
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

// POST update settings
router.post('/settings', (req, res) => {
  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const [key, value] of Object.entries(req.body)) {
    update.run(String(value), key);
  }
  res.json({ success: true });
});

// ─── STATUS ────────────────────────────────────────────────

// GET bot status + wallet balance
router.get('/status', async (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const settingsMap = Object.fromEntries(settings.map(r => [r.key, r.value]));
  const balance = await getWalletBalance();
  const walletCount = db.prepare('SELECT COUNT(*) as c FROM wallets WHERE enabled = 1').get();

  res.json({
    bot_active: settingsMap.bot_active === '1',
    balance_sol: balance,
    active_wallets: walletCount.c,
    helius_connected: req.app.locals.monitor?.ws?.readyState === 1
  });
});

module.exports = router;
