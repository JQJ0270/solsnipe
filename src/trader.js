require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const db = require('./db');

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let connection;
let keypair;

function getConnection() {
  if (!connection) connection = new Connection(HELIUS_RPC, 'confirmed');
  return connection;
}

function getKeypair() {
  if (!keypair) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY not set');
    const secretKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
    keypair = Keypair.fromSecretKey(secretKey);
    console.log(`[Trader] Wallet: ${keypair.publicKey.toString()}`);
  }
  return keypair;
}

async function getWalletBalance() {
  try {
    const kp = getKeypair();
    const conn = getConnection();
    const balance = await conn.getBalance(kp.publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

async function getTokenFromTransaction(signature) {
  try {
    const conn = getConnection();
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });
    if (!tx) return null;
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];
    for (const post of postBalances) {
      const pre = preBalances.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
      if (!pre) continue;
      const preAmt = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
      const postAmt = parseFloat(post.uiTokenAmount.uiAmountString || '0');
      if (post.mint === SOL_MINT || post.mint === USDC_MINT) continue;
      if (postAmt > preAmt) return { mint: post.mint, symbol: post.mint.slice(0, 6) };
    }
    return null;
  } catch (err) {
    console.error('[Trader] Failed to parse tx:', err.message);
    return null;
  }
}

async function executeCopyTrade({ sourceWallet, tradeType, signature, settings, broadcast }) {
  const kp = getKeypair();
  const conn = getConnection();
  const copyAmountSol = parseFloat(settings.copy_amount_sol || '0.25');
  const slippageBps = parseInt(settings.slippage_bps || '1500');
  const amountLamports = Math.floor(copyAmountSol * LAMPORTS_PER_SOL);

  broadcast({ type: 'trade_executing', sourceWallet, tradeType, amountSol: copyAmountSol });

  const tokenInfo = await getTokenFromTransaction(signature);
  if (!tokenInfo) {
    broadcast({ type: 'trade_skipped', reason: 'Could not identify token', sourceWallet });
    return;
  }

  const inputMint = tradeType === 'buy' ? SOL_MINT : tokenInfo.mint;
  const outputMint = tradeType === 'buy' ? tokenInfo.mint : SOL_MINT;

  const params = new URLSearchParams({
    inputMint, outputMint,
    amount: amountLamports.toString(),
    slippageBps: slippageBps.toString()
  });

  const quoteRes = await fetch(`${JUPITER_QUOTE_URL}?${params}`);
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.statusText}`);
  const quote = await quoteRes.json();

  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: kp.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    })
  });
  if (!swapRes.ok) throw new Error(`Swap failed: ${swapRes.statusText}`);
  const { swapTransaction } = await swapRes.json();

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([kp]);

  const txSig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  console.log(`[Trader] ✅ Trade sent: ${txSig}`);

  await db.run_p(
    'INSERT INTO trades (source_wallet, token_mint, token_symbol, type, amount_sol, copy_tx_sig, status) VALUES (?, ?, ?, ?, ?, ?, "confirmed")',
    [sourceWallet, tokenInfo.mint, tokenInfo.symbol, tradeType, copyAmountSol, txSig]
  );

  broadcast({ type: 'trade_copied', sourceWallet, tradeType, tokenMint: tokenInfo.mint, tokenSymbol: tokenInfo.symbol, amountSol: copyAmountSol, txSignature: txSig, timestamp: Date.now() });
  return txSig;
}

module.exports = { executeCopyTrade, getWalletBalance, getKeypair };
