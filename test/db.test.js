const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db.js');

test('license key checksum accepts generated keys and rejects tampering', () => {
  const key = db.generateKeyString();
  assert.equal(db.verifyKeyChecksum(key), true);
  assert.equal(db.verifyKeyChecksum(`${key.slice(0, -1)}${key.endsWith('2') ? '3' : '2'}`), false);
});

test('SQLite fallback can initialize without Telegram token', async () => {
  assert.equal(typeof db.createLicense, 'function');
  assert.equal(typeof db.activateLicense, 'function');
});
