const crypto = require('node:crypto');
const { db } = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const getUser = db.prepare('SELECT id, username, role, is_owner, prefs, created_at, token_version, totp_enabled, last_seen FROM users WHERE id = ?');
const touchUser = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?');

/** Attach req.user / res.locals.user and a CSRF token for every request. */
function loadUser(req, res, next) {
  req.user = req.session.uid ? getUser.get(req.session.uid) || null : null;
  // A password change or "log out everywhere" bumps token_version, which ends older sessions.
  if (req.user && (req.session.v || 0) !== req.user.token_version) req.user = null;
  if (!req.user && req.session.uid) { req.session.uid = null; req.session.mfa = 0; }
  if (req.user) {
    req.user.prefs = require('./prefs').parsePrefs(req.user.prefs);
    const now = Math.floor(Date.now() / 1000);
    if (!(req.user.last_seen > now - 60)) touchUser.run(now, req.user.id); // "last active", at most once a minute
  }
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.user = req.user;
  res.locals.isStaff = isStaff(req.user);
  // Supporters (and staff) don't see ads.
  res.locals.noAds = !!req.user && req.user.role !== 'reader';
  res.locals.csrf = req.session.csrf;
  next();
}

/** Validate the CSRF token on state-changing requests. Run after the body has been parsed. */
function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('x-csrf-token') || req.body?._csrf;
  const expected = req.session.csrf;
  if (
    typeof token === 'string' && expected &&
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  ) return next();
  const err = new Error('Your session expired or the form was stale. Go back, reload the page and try again.');
  err.status = 403;
  next(err);
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (roles.includes(req.user.role)) return next();
    const err = new Error('You do not have permission to do that.');
    err.status = 403;
    next(err);
  };
}

/** Staff = can open the admin panel (translators and admins). Readers and supporters can't. */
const STAFF = ['translator', 'admin'];
function isStaff(user) {
  return !!user && STAFF.includes(user.role);
}

/** Admins may manage everything; translators only their own novels. */
function canManageNovel(user, novel) {
  return !!user && !!novel && (user.role === 'admin' || (user.role === 'translator' && novel.owner_id === user.id));
}

module.exports = { hashPassword, verifyPassword, loadUser, verifyCsrf, requireLogin, requireRole, canManageNovel, isStaff, STAFF, ROLES: ['reader', 'supporter', 'translator', 'admin'] };
