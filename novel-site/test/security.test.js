const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'security-test-'));
const { db } = require('../src/db');
const security = require('../src/security');
const { saveSettings, getSettings } = require('../src/settings');

const req = (ip = '1.2.3.4') => ({ ip, session: {}, get: () => 'test-agent' });

test('TOTP matches the RFC 6238 test vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.strictEqual(security.totpAt(secret, 1), '287082');
  assert.strictEqual(security.totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.strictEqual(security.totpAt(secret, Math.floor(1234567890 / 30)), '005924');
  assert.strictEqual(security.matchTotp(secret, '287 082', 59 * 1000), 1);
  assert.strictEqual(security.matchTotp(secret, '000000', 59 * 1000), null);
});

test('two-factor codes cannot be reused; backup codes work once', () => {
  const uid = Number(db.prepare("INSERT INTO users (username, password_hash) VALUES ('ann', 'x')").run().lastInsertRowid);
  const secret = security.newTotpSecret();
  const { codes, hashes } = security.newBackupCodes();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_backup = ? WHERE id = ?').run(security.encrypt(secret), JSON.stringify(hashes), uid);
  assert.ok(db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(uid).totp_secret.startsWith('enc:v1:'));
  const code = security.totpAt(secret, Math.floor(Date.now() / 30000));
  assert.strictEqual(security.verifySecondFactor(uid, code), 'totp');
  assert.strictEqual(security.verifySecondFactor(uid, code), null); // replay
  assert.strictEqual(security.verifySecondFactor(uid, codes[3].toUpperCase()), 'backup');
  assert.strictEqual(security.verifySecondFactor(uid, codes[3]), null);
  assert.strictEqual(JSON.parse(db.prepare('SELECT totp_backup FROM users WHERE id = ?').get(uid).totp_backup).length, 9);
});

test('encryption round-trips and leaves old plain values readable', () => {
  const e = security.encrypt('xsmtpsib-secret');
  assert.notStrictEqual(e, security.encrypt('xsmtpsib-secret')); // random IV
  assert.strictEqual(security.decrypt(e), 'xsmtpsib-secret');
  assert.strictEqual(security.decrypt('plain'), 'plain');
  const tampered = e.slice(0, -4) + (e.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => security.decrypt(tampered));
});

test('the SMTP password is stored encrypted', () => {
  saveSettings({ smtp_pass: 'my-smtp-key' });
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get().value;
  assert.ok(stored.startsWith('enc:v1:'));
  assert.strictEqual(security.decrypt(getSettings().smtp_pass), 'my-smtp-key');
  saveSettings({ smtp_pass: getSettings().smtp_pass }); // re-saving keeps it (not double-encrypted)
  assert.strictEqual(security.decrypt(getSettings().smtp_pass), 'my-smtp-key');
});

test('5 wrong passwords lock the username; 20 lock the IP address', () => {
  for (let i = 0; i < 5; i++) { security.checkLock(req(), 'bob'); security.recordFailure(req(`9.9.9.${i}`), 'bob'); }
  assert.throws(() => security.checkLock(req('5.5.5.5'), 'BOB'), /Too many wrong attempts/);
  security.clearFailures('bob');
  assert.doesNotThrow(() => security.checkLock(req('5.5.5.5'), 'bob'));
  for (let i = 0; i < 20; i++) security.recordFailure(req('7.7.7.7'), `user${i}`);
  assert.throws(() => security.checkLock(req('7.7.7.7'), 'someone-new'), /Too many/);
});

test('password strength and session versions', () => {
  assert.throws(() => security.checkPasswordStrength('password123'), /too common/);
  assert.throws(() => security.checkPasswordStrength('short'), /8 characters/);
  assert.throws(() => security.checkPasswordStrength('dimpu1234', 'dimpu'), /username/);
  assert.doesNotThrow(() => security.checkPasswordStrength('blue-river-42', 'dimpu'));
  const uid = Number(db.prepare("INSERT INTO users (username, password_hash) VALUES ('cat', 'x')").run().lastInsertRowid);
  const r = req();
  security.startSession(r, uid);
  assert.strictEqual(r.session.v, 0);
  security.bumpTokenVersion(uid, r); // current session follows along
  assert.strictEqual(r.session.v, 1);
  security.bumpTokenVersion(uid); // other sessions (v = 1) are now invalid
  assert.strictEqual(db.prepare('SELECT token_version FROM users WHERE id = ?').get(uid).token_version, 2);
});
