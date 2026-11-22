// db.js - PostgreSQL (DATABASE_URL) with SQLite fallback for local development
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const usePostgres = Boolean(process.env.DATABASE_URL?.trim());
const KEY_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const KEY_SALT = 'klyaksa_aqua_pro_2026_signature';

let pool = null;
let sqlite = null;
if (usePostgres) {
  const { Pool } = require('pg');
  const dbUrl = process.env.DATABASE_URL || '';
  const isInternal = !dbUrl.includes('.') || dbUrl.includes('.internal');
  const sslConfig = (process.env.PGSSLMODE === 'disable' || isInternal)
    ? false
    : { rejectUnauthorized: false };
  pool = new Pool({ connectionString: dbUrl, max: 10, ssl: sslConfig });
} else {
  sqlite = new DatabaseSync(path.join(__dirname, 'database.sqlite'));
}

const schemaSql = `
  CREATE TABLE IF NOT EXISTS licenses (
    key TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'ProLifetime', status TEXT NOT NULL DEFAULT 'available',
    created_at TIMESTAMPTZ NOT NULL, created_by TEXT DEFAULT 'admin', claimed_by BIGINT DEFAULT NULL,
    activated_hwid TEXT DEFAULT NULL, activated_at TIMESTAMPTZ DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, username TEXT, method TEXT NOT NULL,
    amount NUMERIC NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    license_key TEXT DEFAULT NULL, proof_file_id TEXT DEFAULT NULL, created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
  CREATE INDEX IF NOT EXISTS idx_licenses_claimed_by ON licenses(claimed_by);
  CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_proof_file_id ON orders(proof_file_id) WHERE proof_file_id IS NOT NULL;
`;

function sqliteInit() {
  sqlite.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; ${schemaSql.replaceAll('TIMESTAMPTZ', 'TEXT').replaceAll('BIGSERIAL', 'INTEGER').replaceAll('BIGINT', 'INTEGER').replaceAll('NUMERIC', 'REAL').replace('id INTEGER PRIMARY KEY', 'id INTEGER PRIMARY KEY AUTOINCREMENT')}`);
}
const ready = usePostgres ? pool.query(schemaSql).then(() => undefined) : Promise.resolve(sqliteInit());

async function query(text, values = []) {
  await ready;
  if (usePostgres) return (await pool.query(text, values)).rows;
  const sql = text.replace(/\$(\d+)/g, '?');
  const stmt = sqlite.prepare(sql);
  const upper = text.trim().toUpperCase();
  if (upper.startsWith('SELECT') || upper.startsWith('WITH') || upper.includes('RETURNING')) return stmt.all(...values);
  const result = stmt.run(...values);
  return [{ ...result, changes: result.changes, lastInsertRowid: result.lastInsertRowid }];
}

function computeKeyChecksum(payload5) {
  const hash = crypto.createHash('sha256').update(KEY_SALT + String(payload5).toUpperCase()).digest();
  return [hash[0], hash[1], hash[2]].map(n => KEY_CHARSET[n % KEY_CHARSET.length]).join('');
}
function verifyKeyChecksum(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return false;
  const cleaned = rawKey.trim().toUpperCase().replace(/^KLYA-PRO-/, '').replace(/-/g, '');
  return cleaned.length === 8 && cleaned.substring(5) === computeKeyChecksum(cleaned.substring(0, 5));
}
function generateKeyString() {
  const bytes = crypto.randomBytes(5);
  const payload = [...bytes].map(b => KEY_CHARSET[b % KEY_CHARSET.length]).join('');
  return `KLYA-PRO-${payload.substring(0, 4)}-${payload.substring(4)}${computeKeyChecksum(payload)}`;
}

async function createLicense(createdBy = 'admin', tier = 'ProLifetime') {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = generateKeyString(); const createdAt = new Date().toISOString();
    try {
      const rows = await query('INSERT INTO licenses (key,tier,status,created_at,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [key, tier, 'available', createdAt, createdBy]);
      return rows[0];
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) continue;
      throw err;
    }
  }
  throw new Error('Не удалось сгенерировать уникальный лицензионный ключ после 5 попыток');
}
async function createBatchLicenses(count = 5, createdBy = 'admin', tier = 'ProLifetime') {
  const keys = []; for (let i = 0; i < count; i++) keys.push((await createLicense(createdBy, tier)).key); return keys;
}
async function getLicense(rawKey) { if (!rawKey || typeof rawKey !== 'string') return null; const rows = await query('SELECT * FROM licenses WHERE UPPER(key)=UPPER($1)', [rawKey.trim()]); return rows[0] || null; }
async function claimLicense(key, userId) { const rows = await query('UPDATE licenses SET claimed_by=$1 WHERE key=$2', [userId, key]); return rows[0]; }

async function activateLicense(rawKey, hwid, userId = null) {
  if (typeof rawKey !== 'string' || !rawKey.trim() || typeof hwid !== 'string' || !hwid.trim()) return { success: false, error: 'Ключ и идентификатор оборудования (HWID) обязательны.' };
  const key = rawKey.trim().toUpperCase(); if (!verifyKeyChecksum(key)) return { success: false, error: 'Неверный формат или контрольная сумма ключа.' };
  await ready;
  if (usePostgres) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = (await client.query('SELECT * FROM licenses WHERE UPPER(key)=UPPER($1) FOR UPDATE', [key])).rows[0];
      const result = await activateLocked(found, hwid, userId, client);
      await client.query('COMMIT'); return result;
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }
  return activateLocked((await query('SELECT * FROM licenses WHERE UPPER(key)=UPPER($1)', [key]))[0], hwid, userId, null);
}
async function activateLocked(lic, hwid, userId, client) {
  if (!lic) return { success: false, error: 'Лицензионный ключ не найден. Проверьте правильность ввода.' };
  if (lic.status === 'revoked') return { success: false, error: 'Этот лицензионный ключ был аннулирован администратором.' };
  const cleanHwid = String(hwid).trim();
  if (lic.status === 'activated') {
    if (lic.activated_hwid && lic.activated_hwid.toUpperCase() === cleanHwid.toUpperCase()) return { success: true, tier: lic.tier, message: 'Лицензия подтверждена для этого устройства.', license: lic, isReactivation: true };
    return { success: false, error: 'Этот ключ уже активирован на другом устройстве! Ключ klyaksa PRO является единоразовым.' };
  }
  const now = new Date().toISOString();
  const sql = 'UPDATE licenses SET status=$1,activated_hwid=$2,activated_at=$3,claimed_by=COALESCE(claimed_by,$4) WHERE key=$5 AND status=$6 RETURNING *';
  const rows = client ? (await client.query(sql, ['activated', cleanHwid, now, userId, lic.key, 'available'])).rows : await query(sql, ['activated', cleanHwid, now, userId, lic.key, 'available']);
  if (!rows[0]) return { success: false, error: 'Ключ был активирован другим запросом. Попробуйте снова.' };
  return { success: true, tier: rows[0].tier, message: 'Лицензия klyaksa Pro Lifetime by aqua успешно активирована навсегда!', license: rows[0], isReactivation: false };
}
async function getAvailableKeys(limit = 50) { return query('SELECT * FROM licenses WHERE status=$1 ORDER BY created_at DESC LIMIT $2', ['available', limit]); }
async function getUserLicenses(userId) { return query('SELECT * FROM licenses WHERE claimed_by=$1 ORDER BY created_at DESC', [userId]); }
async function getStats() {
  const rows = await query(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='activated' THEN 1 ELSE 0 END) AS activated, SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) AS available FROM licenses`);
  const o = await query(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid, COALESCE(SUM(CASE WHEN status='paid' AND currency='RUB' THEN amount ELSE 0 END),0) AS rub, COALESCE(SUM(CASE WHEN status='paid' AND currency='XTR' THEN amount ELSE 0 END),0) AS stars FROM orders`);
  const l = rows[0], ord = o[0]; return { totalLicenses: Number(l.total), activatedLicenses: Number(l.activated), availableLicenses: Number(l.available), totalOrders: Number(ord.total), paidOrders: Number(ord.paid), revenueRub: Number(ord.rub), revenueStars: Number(ord.stars) };
}
async function createOrder({ userId, username, method, amount, currency, proofFileId = null }) { const rows = await query('INSERT INTO orders (user_id,username,method,amount,currency,status,proof_file_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [userId, username || 'anonymous', method, amount, currency, 'pending', proofFileId, new Date().toISOString()]); return Number(rows[0].id || rows[0].lastInsertRowid); }
async function getOrder(id) { const rows = await query('SELECT * FROM orders WHERE id=$1', [id]); return rows[0] || null; }
async function getPendingOrders() { return query('SELECT * FROM orders WHERE status=$1 ORDER BY created_at ASC', ['pending']); }
async function completeOrder(id, key) { return (await query('UPDATE orders SET status=$1,license_key=$2,updated_at=$3 WHERE id=$4', ['paid', key, new Date().toISOString(), id]))[0]; }
async function declineOrder(id) { return (await query('UPDATE orders SET status=$1,updated_at=$2 WHERE id=$3 AND status=$4', ['declined', new Date().toISOString(), id, 'pending']))[0]; }

async function insertLicense(createdBy, client = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = generateKeyString();
    const now = new Date().toISOString();
    try {
      const sql = 'INSERT INTO licenses (key,tier,status,created_at,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *';
      const rows = client ? (await client.query(sql, [key, 'ProLifetime', 'available', now, createdBy])).rows : await query(sql, [key, 'ProLifetime', 'available', now, createdBy]);
      return rows[0];
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) continue;
      throw err;
    }
  }
  throw new Error('Не удалось сгенерировать уникальный лицензионный ключ после 5 попыток');
}
function insertSqliteLicense(createdBy) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = generateKeyString();
    try {
      return sqlite.prepare('INSERT INTO licenses (key,tier,status,created_at,created_by) VALUES (?,?,?,?,?) RETURNING *').get(key, 'ProLifetime', 'available', new Date().toISOString(), createdBy);
    } catch (err) { if (!/unique|duplicate/i.test(err.message)) throw err; }
  }
  throw new Error('Не удалось сгенерировать уникальный лицензионный ключ после 5 попыток');
}

// Atomically records a Telegram payment and issues its one license. A repeated
// update returns the already paid order and never creates a second key.
async function fulfillStarsPayment({ userId, username, amount, currency, proofFileId }) {
  await ready;
  if (!proofFileId) throw new Error('Telegram payment charge id is required');
  if (usePostgres) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = (await client.query('SELECT * FROM orders WHERE proof_file_id=$1 FOR UPDATE', [proofFileId])).rows[0];
      if (existing) { await client.query('COMMIT'); return existing; }
      const lic = await insertLicense('system_stars', client);
      await client.query('UPDATE licenses SET claimed_by=$1 WHERE key=$2', [userId, lic.key]);
      const rows = (await client.query('INSERT INTO orders (user_id,username,method,amount,currency,status,license_key,proof_file_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [userId, username || 'anonymous', 'stars', amount, currency, 'paid', lic.key, proofFileId, new Date().toISOString(), new Date().toISOString()])).rows;
      await client.query('COMMIT'); return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        const existing = (await client.query('SELECT * FROM orders WHERE proof_file_id=$1', [proofFileId])).rows[0];
        if (existing) return existing;
      }
      throw err;
    } finally { client.release(); }
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const existing = sqlite.prepare('SELECT * FROM orders WHERE proof_file_id=?').get(proofFileId);
    if (existing) { sqlite.exec('COMMIT'); return existing; }
    const lic = insertSqliteLicense('system_stars');
    sqlite.prepare('UPDATE licenses SET claimed_by=? WHERE key=?').run(userId, lic.key);
    const now = new Date().toISOString();
    const result = sqlite.prepare('INSERT INTO orders (user_id,username,method,amount,currency,status,license_key,proof_file_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(userId, username || 'anonymous', 'stars', amount, currency, 'paid', lic.key, proofFileId, now, now);
    sqlite.exec('COMMIT');
    return sqlite.prepare('SELECT * FROM orders WHERE id=?').get(result.lastInsertRowid);
  } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
}

// Claims the pending state inside the same transaction as key creation.
async function approveOrder(id) {
  await ready;
  if (usePostgres) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!order || order.status !== 'pending') { await client.query('COMMIT'); return { order, alreadyProcessed: true }; }
      const lic = await insertLicense('admin_sbp', client);
      await client.query('UPDATE licenses SET claimed_by=$1 WHERE key=$2', [order.user_id, lic.key]);
      const updated = (await client.query('UPDATE orders SET status=$1,license_key=$2,updated_at=$3 WHERE id=$4 AND status=$5 RETURNING *', ['paid', lic.key, new Date().toISOString(), id, 'pending'])).rows[0];
      if (!updated) { await client.query('COMMIT'); return { order, alreadyProcessed: true }; }
      await client.query('COMMIT'); return { order: updated, license: lic, alreadyProcessed: false };
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const order = sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!order || order.status !== 'pending') { sqlite.exec('COMMIT'); return { order, alreadyProcessed: true }; }
    const lic = insertSqliteLicense('admin_sbp');
    sqlite.prepare('UPDATE licenses SET claimed_by=? WHERE key=?').run(order.user_id, lic.key);
    const result = sqlite.prepare('UPDATE orders SET status=?,license_key=?,updated_at=? WHERE id=? AND status=?').run('paid', lic.key, new Date().toISOString(), id, 'pending');
    if (!result.changes) { sqlite.exec('COMMIT'); return { order, alreadyProcessed: true }; }
    sqlite.exec('COMMIT');
    return { order: sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id), license: lic, alreadyProcessed: false };
  } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
}

module.exports = { db: usePostgres ? pool : sqlite, ready, usingPostgres: usePostgres, generateKeyString, verifyKeyChecksum, createLicense, createBatchLicenses, getLicense, claimLicense, activateLicense, getAvailableKeys, getUserLicenses, getStats, createOrder, getOrder, getPendingOrders, completeOrder, declineOrder, fulfillStarsPayment, approveOrder };
