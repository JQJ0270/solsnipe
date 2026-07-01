const db = require('./db');
const { executeCopyTrade } = require('./trader');
const { executePaperTrade } = require('./paper');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

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

    console.log(`[Webhook] Received tx: ${signature}`);

    const rows = await db.all_p('SELECT address FROM wallets WHERE enabled = 1');
    const trackedWallets = rows.map(r => r.address);

    const accountKeys = event.accountData?.map(a => a.account) || [];
    const feePayer = event.feePayer;

    const sourceWallet = trackedWallets.find(addr =>
      addr === feePayer || accountKeys.includes(addr)
    );

    if (!sourceWallet) {
      console.log(`[Webhook] No tracked wallet matched`);
      return;
    }

    console.log(`[Webhook] Matched: ${sourceWallet.slice(0,8)}...`);

    const tokenTransfers = event.tokenTransfers || [];
    let tradeType = null;
    let tokenMint = null;
    let tokenSymbol = null;

    for (const transfer of tokenTransfers) {
      if (transfer.mint === SOL_MINT) continue;
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

    if (!tradeType || !tokenMint) {
      console.log(`[Webhook] Could not determine trade type/token`);
      return;
    }

    console.log(`[Webhook] ${tradeType.toUpperCase()}: ${tokenSymbol} from ${sourceWallet.slice(0,8)}...`);

    broadcast({ type: 'trade_detected', sourceWallet, tradeType, tokenMint, tokenSymbol, signature, timestamp: Date.now() });

    const settingsRows = await db.all_p('SELECT key, value FROM settings');
    const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

    if (tradeType === 'sell' && settings.skip_sells === '1') {
      broadcast({ type: 'trade_skipped', reason: 'Sell filter active', sourceWallet, tradeType });
      return;
    }

    if (settings.bot_active !== '1') return;

    if (settings.paper_mode === '1') {
      await executePaperTrade({ sourceWallet, tradeType, tokenMint, tokenSymbol, settings, broadcast });
    } else {
      await executeCopyTrade({ sourceWallet, tradeType, signature, settings, broadcast });
    }
  } catch (err) {
    console.error('[Webhook] Process error:', err.message);
  }
}

module.exports = { handleWebhook };
