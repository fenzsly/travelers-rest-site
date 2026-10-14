// Anti-scraping for chapter pages:
//  - guests must create a (free) account after reading N chapters (Admin → Email & sign-ups);
//  - the same limit is also counted per IP address (×3, for scrapers that drop cookies);
//  - nobody can load more than 40 chapters a minute.
// Real search-engine crawlers (checked with reverse + forward DNS, not just their user agent) are never limited,
// so Google can still index every chapter.
const dns = require('node:dns').promises;
const { getSettings } = require('./settings');

const CRAWLER_UA = /Googlebot|Google-InspectionTool|GoogleOther|Mediapartners-Google|AdsBot-Google|Storebot-Google|bingbot|BingPreview|msnbot|Applebot|YandexBot|DuckDuckBot/i;
const CRAWLER_HOSTS = /\.(googlebot\.com|google\.com|googleusercontent\.com|search\.msn\.com|applebot\.apple\.com|yandex\.(ru|net|com))$/i;
const PER_MINUTE = 40;
const DAY = 86400000;

const crawlerCache = new Map(); // ip -> { ok, until }
const ipReads = new Map(); // ip -> { start, ids: Set }
const ipRate = new Map(); // ip -> [timestamps in the last minute]

function guestLimit() {
  const n = Number(getSettings().guest_chapter_limit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref())]);
}

/** True only for genuine search-engine crawlers (user agent AND DNS both check out). */
async function isVerifiedCrawler(req) {
  if (!CRAWLER_UA.test(req.get('user-agent') || '')) return false;
  const ip = req.ip;
  const hit = crawlerCache.get(ip);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try {
    const hosts = (await withTimeout(dns.reverse(ip), 2500)) || [];
    for (const host of hosts) {
      if (!CRAWLER_HOSTS.test(host)) continue;
      const addrs = (await withTimeout(dns.lookup(host, { all: true }), 2500)) || [];
      if (addrs.some((a) => a.address === ip)) { ok = true; break; }
    }
  } catch { /* no reverse DNS: not a verified crawler */ }
  if (crawlerCache.size > 5000) crawlerCache.clear();
  crawlerCache.set(ip, { ok, until: Date.now() + (ok ? DAY : 3600000) });
  return ok;
}

/**
 * Decide whether this chapter view may go ahead.
 * Returns null (allowed), { gate: 'signup', limit } or { gate: 'slow' }.
 */
async function checkChapter(req, chapterId) {
  if (await isVerifiedCrawler(req)) return null;
  const now = Date.now();
  const ip = req.ip || 'unknown';

  // Speed limit for everyone (people don't read 40 chapters a minute).
  const recent = (ipRate.get(ip) || []).filter((t) => t > now - 60000);
  recent.push(now);
  ipRate.set(ip, recent);
  if (recent.length > PER_MINUTE) return { gate: 'slow' };

  const limit = guestLimit();
  if (req.user || !limit) return null;

  // Per browser: chapters read as a guest (re-opening one you've read doesn't count).
  const seen = Array.isArray(req.session.seen) ? req.session.seen : [];
  const read = Number(req.session.guestReads) || 0;
  const isNew = !seen.includes(chapterId);
  if (isNew && read >= limit) return { gate: 'signup', limit };

  // Per IP address, for scrapers without cookies. Higher, since several readers can share one address.
  let entry = ipReads.get(ip);
  if (!entry || entry.start < now - DAY) ipReads.set(ip, entry = { start: now, ids: new Set() });
  if (!entry.ids.has(chapterId) && entry.ids.size >= Math.max(limit * 3, 60)) return { gate: 'signup', limit };
  entry.ids.add(chapterId);

  if (isNew) req.session.guestReads = read + 1;
  return null;
}

// Forget old counters so memory stays small.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of ipReads) if (e.start < now - DAY) ipReads.delete(ip);
  for (const [ip, list] of ipRate) if (!list.some((t) => t > now - 60000)) ipRate.delete(ip);
  for (const [ip, c] of crawlerCache) if (c.until < now) crawlerCache.delete(ip);
}, 10 * 60000).unref();

/** For tests. */
function reset() { crawlerCache.clear(); ipReads.clear(); ipRate.clear(); }

module.exports = { checkChapter, isVerifiedCrawler, guestLimit, reset, PER_MINUTE };
