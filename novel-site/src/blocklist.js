// Addresses an admin blocked (Admin → Security → Scraper check). Checked before anything else, from memory.
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

let cache = null; // ip -> until (unix seconds)
function load() {
  cache = new Map(db.prepare('SELECT ip, until FROM blocked_ips WHERE until > unixepoch()').all().map((r) => [r.ip, r.until]));
}

function isBlocked(ip) {
  if (!cache) load();
  const until = cache.get(ip);
  if (!until) return false;
  if (until * 1000 < Date.now()) { cache.delete(ip); return false; }
  return true;
}

function block(ip, hours, reason, by) {
  const until = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  db.prepare(`INSERT INTO blocked_ips (ip, reason, until, created_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, until = excluded.until, created_by = excluded.created_by, created_at = unixepoch()`)
    .run(ip, String(reason || '').slice(0, 200), until, by || '');
  // Also hand it to fail2ban (deploy/harden.sh) so the server firewall drops it too.
  try { fs.appendFileSync(path.join(DATA_DIR, 'blocked.log'), `${new Date().toISOString()} BLOCK ${ip}\n`); } catch { /* ignore */ }
  load();
}

function unblock(ip) {
  db.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(ip);
  load();
}

function list() {
  return db.prepare('SELECT * FROM blocked_ips WHERE until > unixepoch() ORDER BY created_at DESC').all();
}

function middleware(req, res, next) {
  if (!isBlocked(req.ip)) return next();
  // The admin panel stays reachable, so an admin can never lock themselves out by mistake.
  if (/^\/admin(\/|$)/.test(req.path)) return next();
  res.status(403).set('Cache-Control', 'no-store').type('text/plain').send('Access from your address has been blocked. If you think this is a mistake, contact the site owner.');
}

module.exports = { isBlocked, block, unblock, list, middleware };
