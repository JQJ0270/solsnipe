const db = require('./db');

const SOL_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const TOKEN_PRICE_URL = 'https://price.jup.ag/v6/price?ids=';

let solPriceCache = { price: 150, ts: 0 };

async function getSolPrice() {
  if (Date.now() - solPriceCache.ts < 30000) return solPriceCache.price;
  try {
    const res = await fetch(SOL_PRICE_URL);
    const data = await res.json();
    solPriceCache = { price: data.solana.usd, ts: Date.now() };
    return solPriceCache.price;
  } catch {
    return solPriceCache.price;
  }
}

async function getTokenPrice(mint) {
  try {
    const res = await fetch(TOKEN_PRICE_URL + mint);
    const data = await res.json();
    return data.data?.[mint]?.price || 0;
  } catch {
    return 0;
  }
}

async function executePaperTrade({ sourceWallet, tradeType, tokenMint, tokenSymbol, settings, broadcast }) {
  const rows = await db.all_p('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const copyAmountSol = parseFloat(settings?.copy_amount_sol || s.copy_amount_sol || '0.25');
  const solPrice = await getSolPrice();
  const copyAmountUsd = copyAmountSol * solPrice;

  const balanceRow = await db.get_p("SELECT value FROM settings WHERE key = 'paper_balance_usd'");
  const virtualBalance = parseFloat(balanceRow?.value || '100');

  if (virtualBalance < copyAmountUsd) {
    broadcast({ type: 'paper_skipped', reason: 'Insufficient virtual balance', sourceWallet });
    return;
  }

  const entryPrice = await getTokenPrice(tokenMint);
  const tokensReceived = entryPrice > 0 ? copyAmountUsd / entryPrice : 1;
  const slippage = 1 - (0.005 + Math.random() * 0.015);
  const effectiveTokens = tokensReceived * slippage;
  const effectiveEntry = entryPrice > 0 ? copyAmountUsd / effectiveTokens : 0;

  let newBalance = virtualBalance;
  if (tradeType === 'buy') {
    newBalance = virtualBalance - copyAmountUsd;
    await db.run_p("UPDATE settings SET value = ? WHERE key = 'paper_balance_usd'", [newBalance.toFixed(4)]);
  }

  await db.run_p(`
    INSERT INTO paper_trades
    (source_wallet, token_mint, token_symbol, type, amount_sol, amount_usd, entry_price, tokens_held, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `, [sourceWallet, tokenMint, tokenSymbol || tokenMint.slice(0, 6), tradeType, copyAmountSol, copyAmountUsd, effectiveEntry, effectiveTokens]);

  const trade = await db.get_p('SELECT * FROM paper_trades ORDER BY id DESC LIMIT 1');

  broadcast({
    type: 'paper_trade_opened',
    trade,
    virtualBalance: newBalance,
    message: `📄 Paper ${tradeType.toUpperCase()} ${tokenSymbol} — $${copyAmountUsd.toFixed(2)}`
  });

  console.log(`[Paper] ${tradeType.toUpperCase()} ${tokenSymbol} $${copyAmountUsd.toFixed(2)}`);

  const autoSellMultiplier = parseFloat(s.auto_sell_multiplier || '2');
  if (tradeType === 'buy' && autoSellMultiplier > 0) {
    simulateAutoSell(trade, autoSellMultiplier, broadcast);
  }

  return trade;
}

async function simulateAutoSell(trade, multiplier, broadcast) {
  const targetPrice = trade.entry_price * multiplier;
  const stopLoss = trade.entry_price * 0.5;
  let attempts = 0;
  const maxAttempts = 2880;

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) { clearInterval(interval); return; }

    try {
      const currentPrice = await getTokenPrice(trade.token_mint);
      if (currentPrice <= 0) return;

      const shouldSell = currentPrice >= targetPrice || currentPrice <= stopLoss;
      if (!shouldSell) return;

      clearInterval(interval);

      const exitValue = trade.tokens_held * currentPrice;
      const pnlUsd = exitValue - trade.amount_usd;
      const pnlPct = ((exitValue - trade.amount_usd) / trade.amount_usd) * 100;
      const reason = currentPrice >= targetPrice ? `${multiplier}x target hit` : '50% stop loss';

      await db.run_p(`
        UPDATE paper_trades SET status = 'closed', exit_price = ?, pnl_usd = ?, pnl_pct = ?, closed_at = strftime('%s','now')
        WHERE id = ?
      `, [currentPrice, pnlUsd, pnlPct, trade.id]);

      const balanceRow = await db.get_p("SELECT value FROM settings WHERE key = 'paper_balance_usd'");
      const currentBalance = parseFloat(balanceRow?.value || '0');
      const newBalance = currentBalance + exitValue;
      await db.run_p("UPDATE settings SET value = ? WHERE key = 'paper_balance_usd'", [newBalance.toFixed(4)]);

      broadcast({
        type: 'paper_trade_closed',
        tradeId: trade.id,
        tokenSymbol: trade.token_symbol,
        pnlUsd: pnlUsd.toFixed(2),
        pnlPct: pnlPct.toFixed(1),
        reason,
        virtualBalance: newBalance,
        message: `📄 Paper SELL ${trade.token_symbol} — ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%) — ${reason}`
      });

      console.log(`[Paper] SELL ${trade.token_symbol} PnL: $${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
    } catch (err) {
      console.error('[Paper] Auto-sell check failed:', err.message);
    }
  }, 30000);
}

async function getPaperStats() {
  const trades = await db.all_p('SELECT * FROM paper_trades ORDER BY created_at DESC');
  const closed = trades.filter(t => t.status === 'closed');
  const open = trades.filter(t => t.status === 'open');
  const wins = closed.filter(t => t.pnl_usd > 0);
  const totalPnl = closed.reduce((sum, t) => sum + (t.pnl_usd || 0), 0);
  const balanceRow = await db.get_p("SELECT value FROM settings WHERE key = 'paper_balance_usd'");

  return {
    virtualBalance: parseFloat(balanceRow?.value || '100'),
    totalPnl,
    totalTrades: trades.length,
    openTrades: open.length,
    closedTrades: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : 0,
    trades
  };
}

module.exports = { executePaperTrade, getPaperStats };
