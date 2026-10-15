// Daily unique visitors / readers, privacy-friendly:
//  - logged-in readers count once per day by account;
//  - guests count once per day by an anonymous code made from (date, IP address, browser) with a secret key.
//    The code can't be turned back into an IP address and changes every day, so nobody is tracked across days.
// Bots are not counted. Raw rows are kept for 120 days; the admin panel shows daily totals.
const { db } = require('./db');
const { keyedHash } = require('./security');

const today = () => new Date().toISOString().slice(0, 10);

let cacheDay = '';
const seen = new Set(); // "site:visitor" / "novelId:visitor" already written today
function remember(key) {
  const d = today();
  if (d !== cacheDay) {
    cacheDay = d;
    seen.clear();
    cleanup(); // once a day (and on start)
  }
  if (seen.has(key)) return false;
  if (seen.size > 500000) seen.clear(); // memory safety; the database ignores duplicates anyway
  seen.add(key);
  return true;
}

function visitorId(req) {
  if (req.user) return `u${req.user.id}`;
  return keyedHash(`${today()}|${req.ip}|${req.get('user-agent') || ''}`).slice(0, 20);
}

// Anything that isn't a normal browser (search engines, ad reviewers, tools, AI bots) never counts as a visitor.
const isBot = (req) => require('./guard').classify(req) !== 'browser';

const insertVisit = db.prepare('INSERT OR IGNORE INTO site_visitors_daily (day, visitor) VALUES (?, ?)');
const insertReader = db.prepare('INSERT OR IGNORE INTO novel_readers_daily (novel_id, day, visitor) VALUES (?, ?, ?)');

/** Count this visitor for today (call on page views). */
function recordVisit(req) {
  if (isBot(req)) return;
  const v = visitorId(req);
  if (remember(`site:${v}`)) insertVisit.run(today(), v);
}

/** Count this visitor as a reader of the novel today (call on chapter views). */
function recordReader(req, novelId) {
  if (isBot(req)) return;
  const v = visitorId(req);
  if (remember(`${novelId}:${v}`)) insertReader.run(novelId, today(), v);
}

function cleanup() {
  db.prepare("DELETE FROM site_visitors_daily WHERE day < date('now', '-120 days')").run();
  db.prepare("DELETE FROM novel_readers_daily WHERE day < date('now', '-120 days')").run();
}

function fillDays(days, rows) {
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, views: byDay[day] || 0 });
  }
  return out;
}

/** Unique visitors to the whole site per day: [{ day, views }] (views = unique people). */
function siteVisitorsByDay(days = 30) {
  return fillDays(days, db.prepare(`SELECT day, COUNT(*) AS n FROM site_visitors_daily WHERE day >= date('now', ?) GROUP BY day`).all(`-${days - 1} days`));
}

/** Unique readers per day across the given novels (a person reading two novels counts once). */
function readersByDay(days, novelIds) {
  if (!novelIds.length) return fillDays(days, []);
  return fillDays(days, db.prepare(`SELECT day, COUNT(DISTINCT visitor) AS n FROM novel_readers_daily
    WHERE day >= date('now', ?) AND novel_id IN (${novelIds.map(() => '?').join(',')}) GROUP BY day`).all(`-${days - 1} days`, ...novelIds));
}

// ---------- Scraper check: downloads vs. real browser reads ----------
const TRAFFIC_FIELDS = ['chapter_loads', 'chapter_reads', 'bot_loads', 'gate_hits', 'rate_limited', 'ai_blocked'];
const bumpStmts = Object.fromEntries(TRAFFIC_FIELDS.map((f) => [f, db.prepare(`INSERT INTO traffic_daily (day, ${f}) VALUES (?, 1)
  ON CONFLICT(day) DO UPDATE SET ${f} = ${f} + 1`)]));
function bump(field) {
  try { bumpStmts[field].run(today()); } catch { /* never break a page over stats */ }
}

/** Last N days of traffic counters, newest first. */
function trafficByDay(days = 7) {
  const rows = Object.fromEntries(db.prepare("SELECT * FROM traffic_daily WHERE day >= date('now', ?)").all(`-${days - 1} days`).map((r) => [r.day, r]));
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const r = rows[day] || { day, chapter_loads: 0, chapter_reads: 0, bot_loads: 0, gate_hits: 0, rate_limited: 0, ai_blocked: 0 };
    r.unconfirmed = Math.max(0, r.chapter_loads - r.chapter_reads);
    r.pct = r.chapter_loads ? Math.round((r.unconfirmed / r.chapter_loads) * 100) : 0;
    out.push(r);
  }
  return out;
}

const { VISIBLE } = require('./queries');
const chapterForBeacon = db.prepare(`SELECT c.id, c.novel_id FROM chapters c WHERE c.id = ? AND ${VISIBLE}`);

/**
 * POST /beacon: sent by the page's script a moment after it opens in a real browser.
 * Visitors, readers and chapter views are counted here, so scrapers that only download pages
 * (and never run the page) don't inflate the stats.
 */
function beacon(req, res) {
  try {
    if (isBot(req)) return;
    recordVisit(req);
    const chapterId = Number(req.body?.c);
    const chapter = chapterId ? chapterForBeacon.get(chapterId) : null;
    if (!chapter) return;
    bump('chapter_reads');
    recordReader(req, chapter.novel_id);
    // A view counts once per browser session per chapter.
    const viewed = Array.isArray(req.session.viewed) ? req.session.viewed : [];
    if (!viewed.includes(chapter.id)) {
      require('./queries').recordView(chapter.novel_id, chapter.id, req.get('user-agent'));
      req.session.viewed = [...viewed, chapter.id].slice(-60);
    }
  } finally {
    res.status(204).end(); // after the session change, so the cookie is saved
  }
}

module.exports = { recordVisit, recordReader, siteVisitorsByDay, readersByDay, visitorId, isBot, bump, trafficByDay, beacon };
