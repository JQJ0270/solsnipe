const HELIUS_API_BASE = 'https://api.helius.xyz/v0';

async function syncWebhook(walletAddresses) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) { console.warn('[HeliusWebhook] No API key'); return; }

  const base = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_BASE_URL;
  const webhookURL = `${base}/webhook/helius`;

  try {
    const listRes = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`);
    const webhooks = await listRes.json();
    const existing = Array.isArray(webhooks) ? webhooks.find(w => w.webhookURL === webhookURL) : null;

    const payload = {
      webhookURL,
      transactionTypes: ['SWAP', 'TRANSFER'],
      accountAddresses: walletAddresses,
      webhookType: 'enhanced'
    };

    if (existing) {
      await fetch(`${HELIUS_API_BASE}/webhooks/${existing.webhookID}?api-key=${apiKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      console.log(`[HeliusWebhook] Updated webhook with ${walletAddresses.length} wallets`);
    } else {
      await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      console.log(`[HeliusWebhook] Created webhook with ${walletAddresses.length} wallets`);
    }
  } catch (err) {
    console.error('[HeliusWebhook] Sync failed:', err.message);
  }
}

module.exports = { syncWebhook };
