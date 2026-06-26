const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');

// Jupiter V6 API - best swap routing on Solana
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL  = 'https://quote-api.jup.ag/v6/swap';
const SOL_MINT          = 'So11111111111111111111111111111111111111112';
const WSOL_MINT         = 'So11111111111111111111111111111111111111112';

class Trader {
  constructor(rpcUrl, privateKeyB58) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.keypair    = Keypair.fromSecretKey(bs58.decode(privateKeyB58));
    this.publicKey  = this.keypair.publicKey.toBase58();
    console.log('[Trader] Wallet loaded:', this.publicKey.slice(0,8) + '...');
  }

  // Fetch the original tx to figure out which token was swapped
  async parseSwapDetails(signature) {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });
      if (!tx) return null;

      const preBalances  = tx.meta?.preTokenBalances  || [];
      const postBalances = tx.meta?.postTokenBalances || [];

      // Find token that increased in balance (the token bought)
      let tokenMint = null;
      let inputSol  = 0;

      for (const post of postBalances) {
        const pre = preBalances.find(b => b.accountIndex === post.accountIndex && b.mint === post.mint);
        const preAmt  = Number(pre?.uiTokenAmount?.uiAmount  || 0);
        const postAmt = Number(post.uiTokenAmount?.uiAmount  || 0);
        if (postAmt > preAmt && post.mint !== SOL_MINT) {
          tokenMint = post.mint;
        }
      }

      // Estimate SOL spent from account balance changes
      const preSOL  = tx.meta?.preBalances?.[0]  || 0;
      const postSOL = tx.meta?.postBalances?.[0] || 0;
      inputSol = Math.abs((preSOL - postSOL) / 1e9);

      return { tokenMint, inputSol, signature };
    } catch (err) {
      console.error('[Trader] Parse tx error:', err.message);
      return null;
    }
  }

  // Execute a buy via Jupiter
  async buy(tokenMint, solAmount, slippageBps = 1500) {
    const lamports = Math.floor(solAmount * 1e9);
    console.log('[Trader] Buying', tokenMint.slice(0,8) + '...', 'for', solAmount, 'SOL');

    try {
      // 1. Get quote
      const quoteRes = await axios.get(JUPITER_QUOTE_URL, {
        params: {
          inputMint:   SOL_MINT,
          outputMint:  tokenMint,
          amount:      lamports,
          slippageBps
        },
        timeout: 5000
      });
      const quote = quoteRes.data;
      console.log('[Trader] Quote received. Out amount:', quote.outAmount);

      // 2. Get swap transaction
      const swapRes = await axios.post(JUPITER_SWAP_URL, {
        quoteResponse:          quote,
        userPublicKey:          this.publicKey,
        wrapAndUnwrapSol:       true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto' // auto priority fee for speed
      }, { timeout: 8000 });

      const { swapTransaction } = swapRes.data;

      // 3. Deserialize, sign, send
      const txBuf  = Buffer.from(swapTransaction, 'base64');
      const tx     = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.keypair]);

      const rawTx  = tx.serialize();
      const txSig  = await this.connection.sendRawTransaction(rawTx, {
        skipPreflight: true,        // skip simulation for speed
        maxRetries: 3
      });

      console.log('[Trader] TX sent:', txSig);

      // 4. Confirm
      const confirmation = await this.connection.confirmTransaction(txSig, 'confirmed');
      if (confirmation.value.err) throw new Error('TX failed: ' + JSON.stringify(confirmation.value.err));

      console.log('[Trader] BUY confirmed:', txSig);
      return { success: true, signature: txSig, tokenMint, solAmount };

    } catch (err) {
      console.error('[Trader] Buy failed:', err.message);
      return { success: false, error: err.message, tokenMint, solAmount };
    }
  }

  // Execute a sell via Jupiter
  async sell(tokenMint, tokenAmount, slippageBps = 1500) {
    console.log('[Trader] Selling', tokenAmount, 'of', tokenMint.slice(0,8) + '...');
    try {
      const quoteRes = await axios.get(JUPITER_QUOTE_URL, {
        params: {
          inputMint:   tokenMint,
          outputMint:  SOL_MINT,
          amount:      tokenAmount,
          slippageBps
        },
        timeout: 5000
      });
      const quote = quoteRes.data;

      const swapRes = await axios.post(JUPITER_SWAP_URL, {
        quoteResponse:          quote,
        userPublicKey:          this.publicKey,
        wrapAndUnwrapSol:       true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
      }, { timeout: 8000 });

      const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const tx    = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.keypair]);

      const txSig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3
      });

      await this.connection.confirmTransaction(txSig, 'confirmed');
      console.log('[Trader] SELL confirmed:', txSig);
      return { success: true, signature: txSig };

    } catch (err) {
      console.error('[Trader] Sell failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  async getSOLBalance() {
    const bal = await this.connection.getBalance(new PublicKey(this.publicKey));
    return bal / 1e9;
  }
}

module.exports = { executeCopyTrade, getWalletBalance, getKeypair };
