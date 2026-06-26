const express = require('express');
const router = express.Router();
const db = require('./db');
const trader = require('./trader');

router.get('/wallets', async (req, res) => {
  const wallets = await db.all_p('SELECT * FROM wallets ORDER BY created_at DESC');
  res.json(wallets);
});

router.post('/wallets', async (req, res) => {
  const { address, label } = req.body;
  if (!address || address.length < 32) return res.status(400).json({ error: 'Invalid wallet address' });
  try {
    await db.run_p('INSERT INTO wallets (address, label) VALUES (?, ?)', [address, label || 'Wallet']);
    const wallet = await db.get_p('SELECT * FROM wallets WHERE address = ?', [address]);
    req.app.locals.monitor?.refresh();
    res.json(wallet);
  } catch (e) {
    res.status(409).json({ error: 'Wallet already exists' });
  }
});

router.patch('/wallets/:id', async (req, res) => {
  const { enabled, label } = req.body;
  const { id } = req.params;
  if (enabled !== undefined) await db.run_p('UPDATE wallets SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  if (label !== undefined) await db.run_p('UPDATE wallets SET label = ? WHERE id = ?', [label, id]);
  req.app.locals.monitor?.refresh();
  const wallet = await db.get_p('SELECT * FROM wallets WHERE id = ?', [id]);
  res.json(wallet);
});

router.delete('/wallets/:id', async (req, res) => {
  const wallet = await db.get_p('SELECT * FROM wallets WHERE id = ?', [req.params.id]);
  if (!wallet) return res.status(404).json({ error: 'Not found' });
  await db.run_p('DELETE FROM wallets WHERE id = ?', [req.params.id]);
  req.app.locals.monitor?.refresh();
  res.json({ success: true });
});

router.get('/trades', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const trades = await db.all_p('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?', [limit]);
  res.json(trades);
});

router.get('/pnl', async (req, res) => {
  const summary = await db.get_p(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as copied,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) as losses,
      COALESCE(SUM(pnl_usd), 0) as total_pnl_usd
    FROM trades`);
  const byToken = await db.all_p(`
    SELECT token_symbol, token_mint, source_wallet, type, amount_sol, pnl_usd, status, created_at
    FROM trades ORDER BY created_at DESC LIMIT 20`);
  res.json({ summary, byToken });
});

router.get('/settings', async (req, res) => {
  const rows = await db.all_p('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

router.post('/settings', async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    await db.run_p('UPDATE settings SET value = ? WHERE key = ?', [String(value), key]);
  }
  res.json({ success: true });
});

router.get('/status', async (req, res) => {
  const rows = await db.all_p('SELECT key, value FROM settings');
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const balance = await trader.getWalletBalance();
  const walletCount = await db.get_p('SELECT COUNT(*) as c FROM wallets WHERE enabled = 1');
  res.json({
    bot_active: settings.bot_active === '1',
    balance_sol: balance,
    active_wallets: walletCount.c,
    helius_connected: req.app.locals.monitor?.ws?.readyState === 1
  });
});

module.exports = router;
