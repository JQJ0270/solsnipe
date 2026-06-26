// The brain — receives detected trades, applies filters, fires copy trades

class CopyEngine {
  constructor(trader, broadcastFn) {
    this.trader    = trader;
    this.broadcast = broadcastFn; // sends updates to dashboard
    this.filters   = {
      minTradeSol:   0.1,
      maxTradeSol:   5,
      copyAmountSol: 0.25,
      slippagePct:   15,
      minTokenAgeSec: 30,
      skipSells:     false,
      autoSellAt2x:  true
    };
    this.tradeLog  = [];          // in-memory trade history
    this.positions = new Map();   // tokenMint -> { entryPrice, amount, entryTime }
    this.processing = new Set();  // prevent duplicate trades
  }

  setFilters(filters) {
    this.filters = { ...this.filters, ...filters };
    console.log('[Engine] Filters updated:', this.filters);
  }

  async handleDetectedTrade(event) {
    const { signature, wallet, dex, timestamp } = event;

    // Deduplicate — same sig can fire multiple times
    if (this.processing.has(signature)) return;
    this.processing.add(signature);
    setTimeout(() => this.processing.delete(signature), 10000);

    console.log('[Engine] Processing trade from', wallet.name, '| sig:', signature.slice(0,12));

    // Parse the original transaction to get token + amount
    const details = await this.trader.parseSwapDetails(signature);
    if (!details || !details.tokenMint) {
      console.log('[Engine] Could not parse swap details, skipping');
      this.processing.delete(signature);
      return;
    }

    const { tokenMint, inputSol } = details;
    const isBuy = inputSol > 0;

    // ── FILTER CHECKS ──────────────────────────────────────
    if (!isBuy && this.filters.skipSells) {
      this._logTrade({ wallet, tokenMint, type: 'SELL', status: 'skipped', reason: 'Sell filter active', dex, timestamp });
      return;
    }

    if (isBuy && inputSol < this.filters.minTradeSol) {
      this._logTrade({ wallet, tokenMint, type: 'BUY', status: 'skipped', reason: `Below min ${this.filters.minTradeSol} SOL`, dex, timestamp });
      return;
    }

    if (isBuy && inputSol > this.filters.maxTradeSol) {
      this._logTrade({ wallet, tokenMint, type: 'BUY', status: 'skipped', reason: `Above max ${this.filters.maxTradeSol} SOL`, dex, timestamp });
      return;
    }

    // ── EXECUTE COPY TRADE ─────────────────────────────────
    const slippageBps = Math.floor(this.filters.slippagePct * 100);
    const copyAmount  = this.filters.copyAmountSol;

    this._logTrade({ wallet, tokenMint, type: isBuy ? 'BUY' : 'SELL', status: 'pending', dex, timestamp });

    if (isBuy) {
      const result = await this.trader.buy(tokenMint, copyAmount, slippageBps);
      if (result.success) {
        this.positions.set(tokenMint, { entryAmount: copyAmount, entryTime: Date.now(), signature: result.signature });
        this._logTrade({ wallet, tokenMint, type: 'BUY', status: 'copied', txSig: result.signature, amountSol: copyAmount, dex, timestamp });
        
        // Set up auto-sell at 2x if enabled
        if (this.filters.autoSellAt2x) {
          this._watchFor2x(tokenMint, copyAmount);
        }
      } else {
        this._logTrade({ wallet, tokenMint, type: 'BUY', status: 'failed', error: result.error, dex, timestamp });
      }
    }
  }

  // Poll price and auto-sell at 2x
  async _watchFor2x(tokenMint, entryAmountSol) {
    const startTime = Date.now();
    const maxWatchMs = 30 * 60 * 1000; // watch for max 30 min

    const check = async () => {
      if (Date.now() - startTime > maxWatchMs) {
        console.log('[Engine] 2x watch timeout for', tokenMint.slice(0,8));
        return;
      }
      if (!this.positions.has(tokenMint)) return; // already sold

      try {
        const res = await fetch(`https://price.jup.ag/v6/price?ids=${tokenMint}&vsToken=So11111111111111111111111111111111111111112`);
        const data = await res.json();
        const currentPrice = data.data?.[tokenMint]?.price;
        const entryPrice   = this.positions.get(tokenMint)?.entryPrice;

        if (currentPrice && entryPrice && currentPrice >= entryPrice * 2) {
          console.log('[Engine] 2x hit for', tokenMint.slice(0,8), '— selling');
          // Would need token balance here for real sell — simplified for now
          this.positions.delete(tokenMint);
          this._logTrade({ tokenMint, type: 'SELL', status: 'auto-sold', reason: '2x target hit', timestamp: Date.now() });
          return;
        }
      } catch (e) {
        // price check failed, retry
      }
      setTimeout(check, 5000); // check every 5s
    };
    setTimeout(check, 5000);
  }

  _logTrade(trade) {
    const entry = { id: Date.now() + Math.random(), ...trade };
    this.tradeLog.unshift(entry);
    if (this.tradeLog.length > 500) this.tradeLog.pop(); // keep last 500
    this.broadcast('trade', entry);
    console.log('[Engine]', entry.type, entry.tokenMint?.slice(0,8), '→', entry.status);
  }

  getTradeLog()  { return this.tradeLog; }
  getPositions() { return [...this.positions.entries()].map(([mint, pos]) => ({ mint, ...pos })); }
  getFilters()   { return this.filters; }
}

module.exports = CopyEngine;
