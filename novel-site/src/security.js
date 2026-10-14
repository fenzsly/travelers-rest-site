// Account security: login lockouts, security log, encryption of stored secrets, two-factor codes (TOTP).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');

// ---------- Encryption at rest (AES-256-GCM) ----------
// The key lives in DATA_DIR/secret.key (readable only by the site), or in the SECRET_KEY env variable.
let keyCache = null;
function key() {
  if (keyCache) return keyCache;
  if (process.env.SECRET_KEY) {
    keyCache = crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  } else {
    const file = path.join(DATA_DIR, 'secret.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    keyCache = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  }
  return keyCache;
}

const PREFIX = 'enc:v1:';
function encrypt(text) {
  if (text == null || text === '') return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value; // stored before encryption existed
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
/** Keyed one-way hash (for anonymous IDs that can't be turned back into the original). */
function keyedHash(text) {
  return crypto.createHmac('sha256', key()).update(String(text)).digest('hex');
}

const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

// ---------- Security log ----------
function log(req, event, { userId = null, username = '', detail = '' } = {}) {
  db.prepare('INSERT INTO security_log (user_id, username, event, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, String(username || '').slice(0, 60), event, String(req?.ip || '').slice(0, 64), String(req?.get?.('user-agent') || '').slice(0, 300), String(detail).slice(0, 300));
  // Keep the log from growing forever.
  if (Math.random() < 0.01) db.prepare("DELETE FROM security_log WHERE created_at < unixepoch() - 180 * 86400").run();
}

const EVENT_LABELS = {
  login: 'Signed in', login_failed: 'Wrong password', login_locked: 'Blocked: too many attempts', admin_login: 'Opened the admin panel',
  twofa_ok: 'Two-factor code accepted', twofa_failed: 'Wrong two-factor code', twofa_backup: 'Used a backup code',
  twofa_on: 'Turned on two-factor login', twofa_off: 'Turned off two-factor login', backup_new: 'Made new backup codes',
  password_changed: 'Changed password', password_reset: 'Reset password by email', logout_all: 'Logged out all devices',
  admin_reset_password: 'Password reset by an admin', role_changed: 'Role changed', forced_logout: 'Logged out by an admin',
  new_device_alert: 'New sign-in alert emailed',
};

// ---------- Login lockouts ----------
// 5 wrong passwords for one username in 15 minutes locks that username for 15 minutes;
// 20 wrong passwords from one IP address in 15 minutes blocks that address for 15 minutes.
const WINDOW = 15 * 60 * 1000;
const PER_USER = 5;
const PER_IP = 20;
const failures = new Map(); // key -> [timestamps]

function recent(keyName) {
  const now = Date.now();
  const list = (failures.get(keyName) || []).filter((t) => t > now - WINDOW);
  if (list.length) failures.set(keyName, list); else failures.delete(keyName);
  return list;
}

/** Throws a user-facing error if this username or IP address is temporarily locked. */
function checkLock(req, username) {
  // Someone guessing passwords shouldn't be able to lock the real person out: the username lock
  // doesn't apply on an internet address where this account has signed in successfully before.
  const known = db.prepare(`SELECT 1 FROM security_log WHERE username = ? COLLATE NOCASE AND ip = ? AND event IN ('login', 'admin_login')
    AND created_at > unixepoch() - 90 * 86400 LIMIT 1`).get(String(username || ''), String(req.ip || ''));
  const u = known ? [] : recent(`u:${String(username || '').toLowerCase()}`);
  const ip = recent(`ip:${req.ip}`);
  const blocked = u.length >= PER_USER ? u : ip.length >= PER_IP ? ip : null;
  if (blocked) {
    const minutes = Math.max(1, Math.ceil((blocked[0] + WINDOW - Date.now()) / 60000));
    log(req, 'login_locked', { username });
    throw Object.assign(new Error(`Too many wrong attempts. For your safety, try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`), { status: 429 });
  }
}
function recordFailure(req, username) {
  const now = Date.now();
  for (const k of [`u:${String(username || '').toLowerCase()}`, `ip:${req.ip}`]) failures.set(k, [...recent(k), now]);
}
function clearFailures(username) {
  failures.delete(`u:${String(username || '').toLowerCase()}`);
}
setInterval(() => { for (const k of failures.keys()) recent(k); }, WINDOW).unref();

// ---------- Two-factor codes (TOTP, RFC 6238: Google Authenticator, Authy, 1Password, …) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newTotpSecret = () => base32(crypto.randomBytes(20));

function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

/** The 30-second step a valid code belongs to (allowing ±1 step of clock drift), or null. */
function matchTotp(secret, code, now = Date.now()) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    const expected = totpAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return null;
}

const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

/** 10 one-time backup codes like "4f2k-9xq7". Returns { codes, hashes }. */
function newBackupCodes() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes = Array.from({ length: 10 }, () => {
    const b = crypto.randomBytes(8);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}

/**
 * Check a 6-digit code (or a backup code) for a user. Codes can't be reused.
 * Returns 'totp', 'backup' or null.
 */
function verifySecondFactor(userId, input) {
  const u = db.prepare('SELECT totp_secret, totp_last_step, totp_backup FROM users WHERE id = ? AND totp_enabled = 1').get(userId);
  if (!u) return null;
  let secret;
  try {
    secret = decrypt(u.totp_secret);
  } catch {
    // secret.key is missing or different (e.g. the database was restored on a new server).
    // Only backup codes work then; or reset the account with scripts/reset-password.js on the server.
    secret = null;
  }
  const step = secret ? matchTotp(secret, input) : null;
  if (step !== null) {
    if (step <= u.totp_last_step) return null; // already used
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
    return 'totp';
  }
  const backups = JSON.parse(u.totp_backup || '[]');
  const h = hashCode(input);
  const i = String(input || '').trim().length >= 8 ? backups.indexOf(h) : -1;
  if (i === -1) return null;
  backups.splice(i, 1);
  db.prepare('UPDATE users SET totp_backup = ? WHERE id = ?').run(JSON.stringify(backups), userId);
  return 'backup';
}

/** End every session of this user except (optionally) the current one. */
function bumpTokenVersion(userId, req = null) {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
  if (req && req.session && req.session.uid === userId) {
    req.session.v = db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId).token_version;
  }
}

/** Start a logged-in session (after the password was checked). */
function startSession(req, userId) {
  const u = db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId);
  req.session.uid = userId;
  req.session.v = u.token_version;
  req.session.at = Date.now();
  req.session.mfa = 0; // the admin panel asks for the two-factor code separately
  req.session.seenAdmin = 0;
}

const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', 'iloveyou', 'admin123', 'administrator', 'letmein123', 'welcome123', 'abc12345', '11111111', '00000000', 'passw0rd', 'sunshine1', 'football1', 'baseball1', 'trustno1', 'dragon123', 'monkey123', 'princess1', 'zaq12wsx', '1q2w3e4r', 'qwerty12', 'asdfghjkl', 'computer1', 'internet']);

/** Extra rules on top of the 8-character minimum. Throws a user-facing error. */
function checkPasswordStrength(password, username) {
  const p = String(password || '');
  if (p.length < 8) throw Object.assign(new Error('Password must be at least 8 characters.'), { status: 400 });
  if (COMMON_PASSWORDS.has(p.toLowerCase())) throw Object.assign(new Error('That password is too common. Please choose another one.'), { status: 400 });
  if (username && p.toLowerCase().includes(String(username).toLowerCase()) && p.length < String(username).length + 6) {
    throw Object.assign(new Error('Your password shouldn’t be (mostly) your username.'), { status: 400 });
  }
}

module.exports = {
  encrypt, decrypt, isEncrypted, keyedHash, log, EVENT_LABELS, checkLock, recordFailure, clearFailures,
  newTotpSecret, totpAt, matchTotp, newBackupCodes, verifySecondFactor, bumpTokenVersion, startSession, checkPasswordStrength,
};
