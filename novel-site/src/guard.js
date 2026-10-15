// Anti-scraping for chapter pages:
//  - guests must create a (free) account after reading N chapters (Admin → Email & sign-ups);
//  - the same limit is also counted per IP address (×3, for scrapers that drop cookies);
//  - nobody can load more than 40 chapters a minute.
// Real search-engine crawlers (checked with reverse + forward DNS, not just their user agent) are never limited,
// so Google can still index every chapter.
const dns = require('node:dns').promises;
const { getSettings } = require('./settings');

const CRAWLER_UA = /Googlebot|Google-InspectionTool|GoogleOther|Mediapartners-Google|AdsBot-Google|Storebot-Google|bingbot|BingPreview|msnbot|Applebot|YandexBot|DuckDuckBot/i;
// AI-training and data-harvesting bots: told no in robots.txt and refused chapter/novel pages.
const AI_UA = /GPTBot|ChatGPT-User|OAI-SearchBot|CCBot|ClaudeBot|Claude-Web|anthropic-ai|Bytespider|PerplexityBot|Perplexity-User|Amazonbot|meta-externalagent|meta-externalfetcher|FacebookBot|Diffbot|ImagesiftBot|omgili|Timpibot|cohere-ai|YouBot|AI2Bot|Scrapy|PetalBot|SemrushBot|AhrefsBot|MJ12bot|DotBot|DataForSeoBot|serpstatbot|SeekportBot|Barkrowler|BLEXBot|webzio|img2dataset|Kangaroo Bot|Sidetrade/i;
const CRAWLER_HOSTS = /\.(googlebot\.com|google\.com|googleusercontent\.com|search\.msn\.com|applebot\.apple\.com|yandex\.(ru|net|com))$/i;
const PER_MINUTE = 40; // default; Admin → Anti-scraping → speed limit
const DAY = 86400000;

const crawlerCache = new Map(); // ip -> { ok, until }
const ipReads = new Map(); // ip -> { start, ids: Set }
const ipRate = new Map(); // ip -> [timestamps in the last minute]

const userReads = new Map(); // user id -> { day, ids: Set, username }

/** Is this anti-scraping feature switched on? (The master switch turns them all off.) */
function enabled(key) {
  const s = getSettings();
  return s.anti_scraping !== '0' && s[key] !== '0';
}

function speedLimit() {
  const n = Number(getSettings().chapter_speed_limit ?? PER_MINUTE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function accountDailyLimit() {
  if (getSettings().anti_scraping === '0') return 0;
  const n = Number(getSettings().account_daily_limit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function guestLimit() {
  if (getSettings().anti_scraping === '0') return 0;
  const n = Number(getSettings().guest_chapter_limit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref())]);
}

/**
 * What kind of visitor this says it is: 'crawler' (search engines and Google's ad reviewer), 'ai' (AI/data
 * harvesters), 'bot' (other self-declared tools and link previews) or 'browser'.
 */
function classify(req) {
  const ua = req.get('user-agent') || '';
  if (!ua) return 'bot';
  if (AI_UA.test(ua)) return 'ai';
  if (CRAWLER_UA.test(ua)) return 'crawler';
  if (require('./queries').BOT_RE.test(ua)) return 'bot';
  return 'browser';
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
  if (getSettings().anti_scraping === '0') return null;
  if (await isVerifiedCrawler(req)) return null;
  const now = Date.now();
  const ip = req.ip || 'unknown';

  // Speed limit for everyone (people don't read 40 chapters a minute).
  const recent = (ipRate.get(ip) || []).filter((t) => t > now - 60000);
  recent.push(now);
  ipRate.set(ip, recent);
  const perMinute = speedLimit();
  if (perMinute && recent.length > perMinute) return { gate: 'slow' };

  // Accounts: a generous daily cap (people don't read hundreds of chapters a day; scripts do).
  if (req.user) {
    const cap = accountDailyLimit();
    if (!cap) return null;
    const day = new Date().toISOString().slice(0, 10);
    let u = userReads.get(req.user.id);
    if (!u || u.day !== day) userReads.set(req.user.id, u = { day, ids: new Set(), username: req.user.username });
    if (!u.ids.has(chapterId) && u.ids.size >= cap) return { gate: 'daily', limit: cap };
    u.ids.add(chapterId);
    return null;
  }

  const limit = guestLimit();
  if (!limit) return null;

  // Per browser: chapters read as a guest (re-opening one you've read doesn't count).
  const seen = Array.isArray(req.session.seen) ? req.session.seen : [];
  const read = Number(req.session.guestReads) || 0;
  const isNew = !seen.includes(chapterId);
  if (isNew && read >= limit) return { gate: 'signup', limit };

  // Per IP address, for scrapers without cookies. Higher, since several readers can share one address.
  let entry = ipReads.get(ip);
  if (!entry || entry.start < now - DAY) ipReads.set(ip, entry = { start: now, ids: new Set() });
  entry.ua = String(req.get('user-agent') || '').slice(0, 200);
  if (enabled('guest_ip_limit') && !entry.ids.has(chapterId) && entry.ids.size >= Math.max(limit * 3, 60)) return { gate: 'signup', limit };
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

/** Synchronous check: was this IP already verified as a search-engine crawler? (No DNS lookup.) */
function isKnownCrawler(ip) {
  const hit = crawlerCache.get(ip);
  return !!(hit && hit.ok && hit.until > Date.now());
}

/** Addresses that downloaded the most chapters as guests in the last 24 hours (for the admin scraper check). */
function busiest(limit = 10) {
  const now = Date.now();
  const max = Math.max(guestLimit() * 3, 60);
  return [...ipReads.entries()]
    .filter(([, e]) => e.start > now - DAY)
    .map(([ip, e]) => ({ ip, ua: e.ua || '', chapters: e.ids.size, blocked: guestLimit() > 0 && e.ids.size >= max }))
    .sort((a, b) => b.chapters - a.chapters)
    .slice(0, limit);
}

/** Accounts that opened the most chapters today. */
function busiestAccounts(limit = 10) {
  const day = new Date().toISOString().slice(0, 10);
  return [...userReads.entries()].filter(([, u]) => u.day === day)
    .map(([id, u]) => ({ id, username: u.username, chapters: u.ids.size, capped: accountDailyLimit() > 0 && u.ids.size >= accountDailyLimit() }))
    .sort((a, b) => b.chapters - a.chapters).slice(0, limit);
}

/** For tests. */
function reset() { crawlerCache.clear(); ipReads.clear(); ipRate.clear(); userReads.clear(); }

module.exports = { enabled, speedLimit, AI_UA, classify, busiestAccounts, accountDailyLimit, busiest, checkChapter, isVerifiedCrawler, isKnownCrawler, guestLimit, reset, PER_MINUTE };
