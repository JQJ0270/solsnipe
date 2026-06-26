const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../solsnipe.db');
const db = new sqlite3.Database(dbPath);

// Promisify helpers
db.run_p = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));
db.get_p = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); }));
db.all_p = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); }));

// Initialize tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT UNIQUE NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_wallet TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    type TEXT NOT NULL,
    amount_sol REAL,
    copy_tx_sig TEXT,
    status TEXT DEFAULT 'pending',
    pnl_usd REAL,
    entry_price REAL,
    exit_price REAL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Default settings
  const defaults = {
    copy_amount_sol: process.env.DEFAULT_COPY_AMOUNT_SOL || '0.25',
    slippage_bps: process.env.DEFAULT_SLIPPAGE_BPS || '1500',
    min_trade_sol: process.env.MIN_TRADE_SOL || '0.1',
    max_trade_sol: process.env.MAX_TRADE_SOL || '5',
    min_token_age_seconds: process.env.MIN_TOKEN_AGE_SECONDS || '30',
    auto_sell_multiplier: process.env.AUTO_SELL_MULTIPLIER || '2',
    skip_sells: '0',
    bot_active: '1'
  };

  for (const [key, value] of Object.entries(defaults)) {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
  }
});

module.exports = db;
