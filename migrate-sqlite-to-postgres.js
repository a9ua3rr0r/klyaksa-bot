#!/usr/bin/env node
// Idempotent SQLite -> PostgreSQL migration. Does not print keys, tokens, or row contents.
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const path = require('node:path');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.'); process.exit(1);
}
const sqlite = new DatabaseSync(path.join(__dirname, 'database.sqlite'), { readOnly: true });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
});

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS licenses (
    key TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'ProLifetime', status TEXT NOT NULL DEFAULT 'available',
    created_at TIMESTAMPTZ NOT NULL, created_by TEXT DEFAULT 'admin', claimed_by BIGINT DEFAULT NULL,
    activated_hwid TEXT DEFAULT NULL, activated_at TIMESTAMPTZ DEFAULT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, username TEXT, method TEXT NOT NULL,
    amount NUMERIC NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    license_key TEXT DEFAULT NULL, proof_file_id TEXT DEFAULT NULL, created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status)`,
  `CREATE INDEX IF NOT EXISTS idx_licenses_claimed_by ON licenses(claimed_by)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_proof_file_id ON orders(proof_file_id) WHERE proof_file_id IS NOT NULL AND proof_file_id <> ''`
];

async function withRetry(label, work, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = await pool.connect();
    client.on('error', () => {});
    try {
      const result = await work(client);
      client.release();
      return result;
    } catch (error) {
      lastError = error;
      try { client.release(true); } catch {}
      if (attempt === attempts) break;
      const delay = Math.min(5000, attempt * 750);
      console.error(`${label} retry ${attempt}/${attempts - 1} after ${error.code || error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function main() {
  const licenses = sqlite.prepare('SELECT * FROM licenses ORDER BY key').all();
  const orders = sqlite.prepare('SELECT * FROM orders ORDER BY id').all();

  for (let i = 0; i < schemaStatements.length; i++) {
    await withRetry(`schema-${i}`, client => client.query(schemaStatements[i]));
  }

  for (const row of licenses) {
    await withRetry('license', client => client.query(
      `INSERT INTO licenses (key,tier,status,created_at,created_by,claimed_by,activated_hwid,activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (key) DO NOTHING`,
      [row.key,row.tier,row.status,row.created_at,row.created_by,row.claimed_by,row.activated_hwid,row.activated_at]));
  }
  for (const row of orders) {
    await withRetry('order', client => client.query(
      `INSERT INTO orders (id,user_id,username,method,amount,currency,status,license_key,proof_file_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [row.id,row.user_id,row.username,row.method,row.amount,row.currency,row.status,row.license_key,row.proof_file_id,row.created_at,row.updated_at]));
  }

  await withRetry('sequence', client => client.query(
    "SELECT setval(pg_get_serial_sequence('orders','id'), GREATEST(COALESCE((SELECT MAX(id) FROM orders), 1), 1), true)"));
  const counts = await withRetry('verify', client => client.query(
    "SELECT (SELECT COUNT(*) FROM licenses) AS licenses, (SELECT COUNT(*) FROM orders) AS orders"));
  const actualLicenses = Number(counts.rows[0].licenses);
  const actualOrders = Number(counts.rows[0].orders);
  if (actualLicenses < licenses.length || actualOrders < orders.length) {
    throw new Error(`Post-migration count verification failed: ${actualLicenses}/${licenses.length} licenses, ${actualOrders}/${orders.length} orders`);
  }
  console.log(`Migration completed and verified: ${actualLicenses} licenses, ${actualOrders} orders.`);
}

main().catch(err => {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  try { sqlite.close(); } catch {}
  pool.end().catch(() => {});
});
