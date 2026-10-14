// Flood protection inside the app (the first line of defence is Cloudflare / Caddy in front of it):
//  - every IP address gets a request budget per minute (pages, files and form posts counted separately);
//  - an address that keeps going over the limit is banned for a while, and written to a log that
//    fail2ban (deploy/harden.sh) uses to block it in the server's firewall;
//  - if the server gets overloaded anyway, guests get a light "busy" page instead of everything slowing down.
const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const MINUTE = 60 * 1000;
const LIMITS = {
  page: 240,  // HTML pages and API calls per minute (a fast human reader does maybe 20)
  asset: 900, // CSS/JS/images per minute
  post: 40,   // form submissions per minute
};
const CRAWLER_FACTOR = 5;      // verified Google/Bing crawlers get 5× the budget
const STRIKES_TO_BAN = 3;      // minutes over the limit (within 10 minutes) before a ban
const BAN_MS = 15 * MINUTE;
const MAX_TRACKED = 200000;    // memory safety: forget everyone if this many addresses are tracked

const counters = new Map(); // ip -> { start, page, asset, post, strikes: [ts], bannedUntil }
let blockLog = null;

function blockLogPath() {
  if (blockLog === null) {
    const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    blockLog = path.join(dir, 'blocked.log');
  }
  return blockLog;
}

function kindOf(req) {
  // Admin pages save lots of small edits (chapter titles, uploads…), so they use the bigger page budget.
  if (req.method !== 'GET' && req.method !== 'HEAD') return /^\/admin(\/|$)/.test(req.originalUrl || req.path) ? 'page' : 'post';
  if (/^\/(static|uploads|assets|favicon|icon-|apple-touch)/.test(req.path) || /\/(assets|uploads)\//.test(req.originalUrl)) return 'asset';
  return 'page';
}

function tooMany(res, seconds, message) {
  res.set('Retry-After', String(seconds));
  res.set('Cache-Control', 'no-store');
  res.status(429).type('text/plain').send(message);
}

// ---------- Overload protection ----------
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
let overloaded = false;
setInterval(() => {
  // If the server is falling behind by more than a quarter second, shed guest traffic until it recovers.
  const p99 = lag.percentile(99) / 1e6;
  overloaded = p99 > 250;
  lag.reset();
}, 2000).unref();

function middleware(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let c = counters.get(ip);
  if (!c || now - c.start >= MINUTE) {
    if (!c && counters.size >= MAX_TRACKED) counters.clear();
    c = { start: now, page: 0, asset: 0, post: 0, strikes: c ? c.strikes : [], bannedUntil: c ? c.bannedUntil : 0, struck: false };
    counters.set(ip, c);
  }

  if (c.bannedUntil > now) return tooMany(res, Math.ceil((c.bannedUntil - now) / 1000), 'Too many requests from your address. Please wait a few minutes and try again.');

  const kind = kindOf(req);
  c[kind] += 1;
  const crawler = require('./guard').isKnownCrawler(ip);
  const limit = LIMITS[kind] * (crawler ? CRAWLER_FACTOR : 1);
  if (c[kind] > limit) {
    if (!c.struck) {
      c.struck = true; // one strike per minute
      c.strikes = [...c.strikes.filter((t) => t > now - 10 * MINUTE), now];
      if (c.strikes.length >= STRIKES_TO_BAN && !crawler) {
        c.bannedUntil = now + BAN_MS;
        c.strikes = [];
        console.warn(`[ratelimit] banned ${ip} for 15 minutes (flooding)`);
        try { fs.appendFileSync(blockLogPath(), `${new Date().toISOString()} BLOCK ${ip}\n`); } catch { /* read-only disk etc. */ }
      }
    }
    return tooMany(res, Math.ceil((c.start + MINUTE - now) / 1000), 'You’re going a bit fast. Please wait a moment and try again.');
  }

  // Overloaded: keep the site working for readers who already have our cookie (and staff), shed cookieless page loads.
  // Anyone who has visited before carries our cookie; flood tools usually don't keep cookies.
  const hasSession = /(?:^|;\s*)nsid=/.test(req.headers.cookie || '');
  if (overloaded && kind === 'page' && !hasSession && !crawler && !/^\/admin/.test(req.originalUrl)) {
    res.set('Retry-After', '10');
    return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Busy</title><body style="font-family:sans-serif;text-align:center;padding:60px 16px;background:#16181d;color:#ddd"><h1>We’re very busy right now</h1><p>Please try again in a few seconds.</p><script>setTimeout(function(){location.reload()},8000)</script>');
  }
  next();
}

// Forget old counters every few minutes.
setInterval(() => {
  const now = Date.now();
  for (const [ip, c] of counters) if (now - c.start > 10 * MINUTE && c.bannedUntil < now) counters.delete(ip);
}, 5 * MINUTE).unref();

function status() {
  const now = Date.now();
  return { tracked: counters.size, banned: [...counters.values()].filter((c) => c.bannedUntil > now).length, overloaded };
}

function reset() { counters.clear(); }

module.exports = { middleware, status, reset, LIMITS, STRIKES_TO_BAN };
