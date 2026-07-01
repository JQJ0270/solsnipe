const db = require('./db');
const { executeCopyTrade } = require('./trader');
const { executePaperTrade } = require('./paper');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const recentSignatures = new Set();

async function handleWebhook(req, res, broadcast) {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    res.status(200).json({ received: true });
    for (const event of events) {
      await processTransaction(event, broadcast);
    }
  } catch (err) {
    console.error('[Webhook] Error:', err.message);
  }
}

async function processTransaction(event, broadcast) {
  try {
    const signature = event.signature;
    if (!signature) return;

    if (recentSignatures.has(signature)) return;
    recentSignatures.add(signature);
    if (recentSignatures.size > 500) {
      recentSignatures.delete(recentSignatures.values().next().value);
    }

    if (event.transactionError) {
      console.log(`[Webhook] Skipping failed tx`);
      return;
    }

    const rows = await db.all_p('SELECT address FROM wallets WHERE enabled = 1');
    const trackedWallets = rows.map(r => r.address);

    const accountKeys = event.accountData?.map(a => a.account) || [];
    const feePayer = event.feePayer;

    const sourceWallet = trackedWallets.find(addr =>
      addr === feePayer || accountKeys.includes(addr)
    );

    if (!sourceWallet) return;

    const tokenTransfers = event.tokenTransfers || [];
    let tradeType = null;
    let tokenMint = null;
    let tokenSymbol = null;

    for (const transfer of tokenTransfers) {
      if (!transfer.mint || transfer.mint === SOL_MINT) continue;
      if (transfer.toUserAccount === sourceWallet) {
        tradeType = 'buy';
        tokenMint = transfer.mint;
        tokenSymbol = transfer.tokenSymbol || transfer.mint.slice(0, 6);
        break;
      } else if (transfer.fromUserAccount === sourceWallet) {
        tradeType = 'sell';
        tokenMint = transfer.mint;
        tokenSymbol = transfer.tokenSymbol || transfer.mint.slice(0, 6);
        break;
      }
    }

    if (!tradeType || !tokenMint) return;

    const settingsRows = await db.all_p('SELECT key, value FROM settings');
    const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    if (tradeType === 'sell' && settings.skip_sells === '1') {
      broadcast({ type: 'trade_skipped', reason: 'Sell filter active', sourceWallet, tradeType, tokenSymbol });
      return;
    }

    if (settings.bot_active !== '1') return;

    console.log(`[Webhook] ${tradeType.toUpperCase()} ${tokenSymbol} from ${sourceWallet.slice(0,8)}...`);
    broadcast({ type: 'trade_detected', sourceWallet, tradeType, tokenMint, tokenSymbol, signature, timestamp: Date.now() });

    if (settings.paper_mode === '1') {
      if (tradeType === 'sell') {
        await closePaperPosition(sourceWallet, tokenMint, tokenSymbol, broadcast);
      } else {
        await executePaperTrade({ sourceWallet, tradeType, tokenMint, tokenSymbol, settings, broadcast });
      }
    } else {
      await executeCopyTrade({ sourceWallet, tradeType, signature, settings, broadcast });
    }
  } catch (err) {
    console.error('[Webhook] Process error:', err.message);
  }
}

async function closePaperPosition(sourceWallet, tokenMint, tokenSymbol, broadcast) {
  try {
    const openTrade = await db.get_p(
      "SELECT * FROM paper_trades WHERE source_wallet = ? AND token_mint = ? AND status = 'open' AND type = 'buy' ORDER BY created_at ASC LIMIT 1",
      [sourceWallet, tokenMint]
    );

    if (!openTrade) return;

    let exitPrice = 0;
    let exitValue = openTrade.amount_usd;
    let pnlUsd = 0;

    try {
      const res = await fetch(`https://price.jup.ag/v6/price?ids=${tokenMint}`);
      const data = await res.json();
      exitPrice = data.data?.[tokenMint]?.price || 0;
      if (exitPrice > 0 && openTrade.tokens_held > 0) {
        exitValue = openTrade.tokens_held * exitPrice;
        pnlUsd = exitValue - openTrade.amount_usd;
      }
    } catch {
      exitValue = openTrade.amount_usd * 0.8;
      pnlUsd = exitValue - openTrade.amount_usd;
    }

    const pnlPct = ((exitValue - openTrade.amount_usd) / openTrade.amount_usd) * 100;

    await db.run_p(
      "UPDATE paper_trades SET status = 'closed', exit_price = ?, pnl_usd = ?, pnl_pct = ?, closed_at = extract(epoch from now()) WHERE id = ?",
      [exitPrice, pnlUsd, pnlPct, openTrade.id]
    );

    const balanceRow = await db.get_p("SELECT value FROM settings WHERE key = 'paper_balance_usd'");
    const newBalance = parseFloat(balanceRow?.value || '0') + exitValue;
    await db.run_p("UPDATE settings SET value = ? WHERE key = 'paper_balance_usd'", [newBalance.toFixed(4)]);

    broadcast({
      type: 'paper_trade_closed',
      tradeId: openTrade.id,
      tokenSymbol,
      pnlUsd: pnlUsd.toFixed(2),
      pnlPct: pnlPct.toFixed(1),
      reason: 'Wallet sold',
      virtualBalance: newBalance,
      message: `📄 Paper SELL ${tokenSymbol} — ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)`
    });

    console.log(`[Webhook] Closed ${tokenSymbol}: $${pnlUsd.toFixed(2)}`);
  } catch (err) {
    console.error('[Webhook] Close position error:', err.message);
  }
}

module.exports = { handleWebhook };
