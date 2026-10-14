// Middleware shared by the public site and the (independent) admin app.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { DATA_DIR } = require('./db');
const { loadUser } = require('./auth');
const { getSettings } = require('./settings');
const util = require('./util');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(path.join(UPLOAD_DIR, 'covers'), { recursive: true });

// "/static/js/reader.js" -> "/static/js/reader.js?v=3f9a1c2b": the version changes whenever the file does,
// so browsers (Safari especially) never keep running an old script or stylesheet after an update.
const assetVersions = new Map();
function assetUrl(urlPath, dir = path.join(__dirname, '..', 'public'), prefix = '/static') {
  const key = `${dir}|${urlPath}`;
  if (!assetVersions.has(key)) {
    let v = '';
    try { v = crypto.createHash('md5').update(fs.readFileSync(path.join(dir, urlPath.slice(prefix.length)))).digest('hex').slice(0, 8); } catch { /* missing file */ }
    assetVersions.set(key, v);
  }
  const v = assetVersions.get(key);
  return v ? `${urlPath}?v=${v}` : urlPath;
}

/** Browser security headers for every page. */
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN', // no other site can show our pages in a frame (clickjacking)
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  });
  if (process.env.COOKIE_SECURE === '1') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

const session = cookieSession({
  name: 'nsid',
  keys: [sessionSecret()],
  maxAge: 30 * 24 * 3600 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === '1',
});

/**
 * Creates an Express app with sessions, body parsing, user loading and shared view locals.
 * Pass { mounted: true } for a sub-app mounted inside another baseApp (the parent already did the work).
 */
function baseApp(viewsDir, { mounted = false } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  // Behind Caddy: trust exactly one proxy hop, so visitors can't fake their IP address with X-Forwarded-For.
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.disable('x-powered-by');
  if (mounted) return app;
  app.use(securityHeaders);
  app.use(session);
  app.use(express.urlencoded({ extended: false, limit: '5mb' }));
  app.use(express.json({ limit: '60mb' }));
  app.use(loadUser);
  app.use((req, res, next) => {
    res.locals.settings = getSettings();
    res.locals.u = util;
    res.locals.asset = (p) => assetUrl(p);
    res.locals.path = req.path;
    res.locals.query = req.query;
    res.locals.flash = req.session.flash || null;
    req.session.flash = null;
    req.flash = (type, message) => { req.session.flash = { type, message }; };
    next();
  });
  return app;
}

function errorHandlers(app, view) {
  app.use((req, res) => res.status(404).render(view, { status: 404, message: 'Page not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong on our side.' : err.message;
    if (req.accepts(['html', 'json']) === 'json' || req.xhr) return res.status(status).json({ error: message });
    res.status(status).render(view, { status, message });
  });
}

module.exports = { baseApp, errorHandlers, assetUrl, UPLOAD_DIR };
