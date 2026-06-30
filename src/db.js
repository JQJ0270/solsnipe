const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false
});

const db = {
  run_p: async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result;
  },
  get_p: async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
  },
  all_p: async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result.rows;
  }
};

const originalRunP = db.run_p;
const originalGetP = db.get_p;
const originalAllP = db.all_p;

function convertQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

db.run_p = (sql, params = []) => originalRunP(convertQuery(sql), params);
db.get_p = (sql, params = []) => originalGetP(convertQuery(sql), params);
db.all_p = (sql, params = []) => originalAllP(convertQuery(sql), params);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id SERIAL PRIMARY KEY,
      address TEXT UNIQUE NOT NULL,
      label TEXT,
      enabled INTEGER DEFAULT 1,
      created_at BIGINT DEFAULT extract(epoch from now())
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
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
      created_at BIGINT DEFAULT extract(epoch from now())
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id SERIAL PRIMARY KEY,
      source_wallet TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      type TEXT NOT NULL,
      amount_sol REAL,
      amount_usd REAL,
      entry_price REAL,
      exit_price REAL,
      tokens_held REAL,
      pnl_usd REAL,
      pnl_pct REAL,
      status TEXT DEFAULT 'open',
      created_at BIGINT DEFAULT extract(epoch from now()),
      closed_at BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  const defaults = {
    copy_amount_sol: process.env.DEFAULT_COPY_AMOUNT_SOL || '0.25',
    slippage_bps: process.env.DEFAULT_SLIPPAGE_BPS || '1500',
    min_trade_sol: process.env.MIN_TRADE_SOL || '0.1',
    max_trade_sol: process.env.MAX_TRADE_SOL || '5',
    min_token_age_seconds: process.env.MIN_TOKEN_AGE_SECONDS || '30',
    auto_sell_multiplier: process.env.AUTO_SELL_MULTIPLIER || '2',
    skip_sells: '0',
    bot_active: '1',
    paper_mode: '1',
    paper_balance_usd: '100'
  };

  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }

  console.log('[DB] PostgreSQL tables initialized');
}

initDb().catch(err => console.error('[DB] Init error:', err.message));

module.exports = db;
