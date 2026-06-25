const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../solsnipe.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT UNIQUE NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS trades (
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
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

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

const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
`);

for (const [key, value] of Object.entries(defaults)) {
  insertSetting.run(key, value);
}

module.exports = db;
