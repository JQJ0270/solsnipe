const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const db = require('./db');

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

// SOL mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112';
// USDC mint (used for price checks)
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let connection;
let keypair;

function getConnection() {
  if (!connection) {
    connection = new Connection(HELIUS_RPC, 'confirmed');
  }
  return connection;
}

function getKeypair() {
  if (!keypair) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error('WALLET_PRIVATE_KEY not set in environment variables');
    }
    const secretKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
    keypair = Keypair.fromSecretKey(secretKey);
    console.log(`[Trader] Loaded wallet: ${keypair.publicKey.toString()}`);
  }
  return keypair;
}

async function getTokenFromTransaction(signature) {
  try {
    const conn = getConnection();
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx) return null;

    // Look through token balance changes to find the token being swapped
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    // Find tokens that increased (bought) or decreased (sold)
    for (const post of postBalances) {
      const pre = preBalances.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
      if (!pre) continue;

      const preAmt = parseFloat(pre.uiTokenAmount.uiAmountString || '0');
      const postAmt = parseFloat(post.uiTokenAmount.uiAmountString || '0');

      // Skip SOL and USDC
      if (post.mint === SOL_MINT || post.mint === USDC_MINT) continue;

      if (postAmt > preAmt) {
        // Token amount increased = this is what was bought
        return {
          mint: post.mint,
          symbol: post.uiTokenAmount.decimals ? post.mint.slice(0, 6) : 'UNKNOWN'
        };
      }
    }

    return null;
  } catch (err) {
    console.error('[Trader] Failed to parse transaction:', err.message);
    return null;
  }
}

async function getJupiterQuote(inputMint, outputMint, amountLamports, slippageBps) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    slippageBps: slippageBps.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false'
  });

  const res = await fetch(`${JUPITER_QUOTE_URL}?${params}`);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.statusText}`);
  return res.json();
}

async function executeJupiterSwap(quoteResponse, walletPublicKey) {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: walletPublicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto' // auto priority fee for speed
    })
  });

  if (!res.ok) throw new Error(`Jupiter swap failed: ${res.statusText}`);
  return res.json();
}

async function executeCopyTrade({ sourceWallet, tradeType, signature, settings, broadcast }) {
  const kp = getKeypair();
  const conn = getConnection();

  const copyAmountSol = parseFloat(settings.copy_amount_sol || '0.25');
  const slippageBps = parseInt(settings.slippage_bps || '1500');
  const amountLamports = Math.floor(copyAmountSol * LAMPORTS_PER_SOL);

  broadcast({
    type: 'trade_executing',
    sourceWallet,
    tradeType,
    amountSol: copyAmountSol
  });

  // Step 1: Get the token from the source transaction
  console.log(`[Trader] Fetching token from tx: ${signature}`);
  const tokenInfo = await getTokenFromTransaction(signature);

  if (!tokenInfo) {
    console.log('[Trader] Could not identify token, skipping');
    broadcast({ type: 'trade_skipped', reason: 'Could not identify token', sourceWallet });
    return;
  }

  console.log(`[Trader] Token identified: ${tokenInfo.mint}`);

  // Step 2: Determine swap direction
  const inputMint = tradeType === 'buy' ? SOL_MINT : tokenInfo.mint;
  const outputMint = tradeType === 'buy' ? tokenInfo.mint : SOL_MINT;

  // Step 3: Get Jupiter quote
  console.log(`[Trader] Getting Jupiter quote...`);
  let quote;
  try {
    quote = await getJupiterQuote(inputMint, outputMint, amountLamports, slippageBps);
  } catch (err) {
    throw new Error(`Quote failed: ${err.message}`);
  }

  // Step 4: Build swap transaction
  console.log(`[Trader] Building swap transaction...`);
  const { swapTransaction } = await executeJupiterSwap(quote, kp.publicKey);

  // Step 5: Deserialize and sign
  const swapTxBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapTxBuf);
  tx.sign([kp]);

  // Step 6: Send with high priority for low latency
  console.log(`[Trader] Sending transaction...`);
  const txSig = await conn.sendTransaction(tx, {
    skipPreflight: true, // skip simulation for speed
    maxRetries: 3,
    preflightCommitment: 'confirmed'
  });

  console.log(`[Trader] ✅ Trade sent! Sig: ${txSig}`);

  // Step 7: Save to database
  db.prepare(`
    INSERT INTO trades (source_wallet, token_mint, token_symbol, type, amount_sol, copy_tx_sig, status)
    VALUES (?, ?, ?, ?, ?, ?, 'confirmed')
  `).run(sourceWallet, tokenInfo.mint, tokenInfo.symbol, tradeType, copyAmountSol, txSig);

  broadcast({
    type: 'trade_copied',
    sourceWallet,
    tradeType,
    tokenMint: tokenInfo.mint,
    tokenSymbol: tokenInfo.symbol,
    amountSol: copyAmountSol,
    txSignature: txSig,
    timestamp: Date.now()
  });

  return txSig;
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

module.exports = { executeCopyTrade, getWalletBalance, getKeypair };
