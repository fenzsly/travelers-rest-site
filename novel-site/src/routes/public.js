const express = require('express');
const { db } = require('../db');
const { q, NOVEL_COLUMNS, VISIBLE, RELEASED, recordView, login, register } = require('../queries');
const { verifyCsrf, requireLogin } = require('../auth');
const { getSettings } = require('../settings');
const { paginate, chapterLabel, formatNumber, STATUS_LABELS, LIST_LABELS, REACTIONS, REPORT_KINDS } = require('../util');

const router = express.Router();
router.use(verifyCsrf);

const PER_PAGE = 20;
const CHAPTERS_PER_PAGE = 100;

function notFound(message = 'Page not found.') {
  return Object.assign(new Error(message), { status: 404 });
}

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function baseUrl(req) {
  return process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

router.use((req, res, next) => {
  res.locals.baseUrl = baseUrl(req);
  res.locals.navGenres = q.allGenres.all();
  res.locals.updates = req.user ? libraryUpdates(req.user.id) : [];
  next();
});

/** Novels in the reader's Reading / Plan to read lists with chapters they haven't reached yet. */
function libraryUpdates(userId) {
  return db.prepare(`SELECT n.slug, n.title, c.number AS last_number,
      (SELECT MAX(c2.number) FROM chapters c2 WHERE c2.novel_id = n.id AND ${VISIBLE.replaceAll('c.', 'c2.')}) AS latest_number,
      (SELECT MIN(c2.number) FROM chapters c2 WHERE c2.novel_id = n.id AND c2.number > COALESCE(c.number, -1) AND ${VISIBLE.replaceAll('c.', 'c2.')}) AS next_number,
      (SELECT COUNT(*) FROM chapters c2 WHERE c2.novel_id = n.id AND c2.number > COALESCE(c.number, -1) AND ${VISIBLE.replaceAll('c.', 'c2.')}) AS unread
    FROM bookmarks b JOIN novels n ON n.id = b.novel_id LEFT JOIN chapters c ON c.id = b.last_chapter_id
    WHERE b.user_id = ? AND b.status IN ('reading', 'plan') AND b.last_chapter_id IS NOT NULL
    ORDER BY n.updated_at DESC`).all(userId).filter((r) => r.unread > 0).slice(0, 20);
}

const HAS_CHAPTERS = `EXISTS (SELECT 1 FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE})`;

// ---------- Home ----------
router.get('/', (req, res) => {
  const popular = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE ${HAS_CHAPTERS} ORDER BY n.views DESC LIMIT 12`).all();
  const updated = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE ${HAS_CHAPTERS} ORDER BY last_release DESC LIMIT 15`).all();
  const recentChapters = db.prepare(`SELECT c.id, c.number, c.title, ${RELEASED} AS released_at FROM chapters c
    WHERE c.novel_id = ? AND ${VISIBLE} ORDER BY released_at DESC, c.number DESC LIMIT 3`);
  for (const n of updated) n.recent = recentChapters.all(n.id);
  const fresh = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n ORDER BY n.created_at DESC LIMIT 6`).all();
  const topRated = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE rating_count > 0 ORDER BY rating DESC, rating_count DESC LIMIT 6`).all();
  const trending = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE views_week > 0 ORDER BY views_week DESC LIMIT 8`).all();
  const completed = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE n.status = 'completed' AND ${HAS_CHAPTERS} ORDER BY n.views DESC LIMIT 6`).all();
  const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM novels) AS novels,
    (SELECT COUNT(*) FROM chapters c WHERE ${VISIBLE}) AS chapters,
    (SELECT COALESCE(SUM(views), 0) FROM novels) AS views`).get();
  res.render('home', { popular, updated, fresh, topRated, trending, completed, totals, genres: q.allGenres.all() });
});

// ---------- Catalog / search ----------
const SORTS = {
  updated: 'last_release DESC',
  trending: 'views_week DESC, n.views DESC',
  month: 'views_month DESC, n.views DESC',
  popular: 'n.views DESC',
  rating: 'rating IS NULL, rating DESC, rating_count DESC',
  new: 'n.created_at DESC',
  chapters: 'chapter_count DESC',
  title: 'n.title COLLATE NOCASE ASC',
};

router.get('/novels', (req, res) => {
  const where = [];
  const params = [];
  const search = String(req.query.q || '').trim();
  if (search) {
    where.push('(n.title LIKE ? OR n.alt_titles LIKE ? OR n.author LIKE ? OR n.tags LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const genre = String(req.query.genre || '');
  if (genre) {
    where.push('EXISTS (SELECT 1 FROM novel_genres ng JOIN genres g ON g.id = ng.genre_id WHERE ng.novel_id = n.id AND g.slug = ?)');
    params.push(genre);
  }
  const status = String(req.query.status || '');
  if (STATUS_LABELS[status]) {
    where.push('n.status = ?');
    params.push(status);
  }
  const tag = String(req.query.tag || '').trim();
  if (tag) {
    where.push("(',' || REPLACE(LOWER(n.tags), ', ', ',') || ',') LIKE ?");
    params.push(`%,${tag.toLowerCase()},%`);
  }
  const sort = SORTS[req.query.sort] ? req.query.sort : 'updated';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM novels n ${whereSql}`).get(...params).c;
  const pager = paginate(total, Number(req.query.page), PER_PAGE);
  const novels = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n ${whereSql} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`)
    .all(...params, PER_PAGE, pager.offset);
  const genres = q.allGenres.all();
  res.render('catalog', {
    novels, pager, genres, search, genre, status, sort, tag,
    activeGenre: genres.find((g) => g.slug === genre),
  });
});

router.get('/search', (req, res) => res.redirect(`/novels?q=${encodeURIComponent(req.query.q || '')}`));
router.get('/genre/:slug', (req, res) => res.redirect(`/novels?genre=${encodeURIComponent(req.params.slug)}`));
router.get('/ranking', (req, res) => res.redirect('/novels?sort=trending'));

router.get('/random', (req, res) => {
  const n = db.prepare(`SELECT n.slug FROM novels n WHERE ${HAS_CHAPTERS} ORDER BY RANDOM() LIMIT 1`).get();
  res.redirect(n ? `/novel/${n.slug}` : '/novels');
});

// Search suggestions for the header search box.
router.get('/api/search', (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json([]);
  const like = `%${term}%`;
  const rows = db.prepare(`SELECT n.slug, n.title, n.cover, n.status,
      (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}) AS chapter_count
    FROM novels n WHERE n.title LIKE ? OR n.alt_titles LIKE ? OR n.author LIKE ?
    ORDER BY (n.title LIKE ?) DESC, n.views DESC LIMIT 8`).all(like, like, like, `${term}%`);
  res.json(rows);
});

// ---------- Novel page ----------
function loadNovel(req, res, next) {
  const novel = q.novelBySlug.get(req.params.slug);
  if (!novel) return next(notFound('Novel not found.'));
  req.novel = novel;
  next();
}

router.get('/novel/:slug', loadNovel, (req, res) => {
  const novel = req.novel;
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const pager = paginate(novel.chapter_count, Number(req.query.page), CHAPTERS_PER_PAGE);
  const chapters = db.prepare(`SELECT c.id, c.number, c.volume, c.title, ${RELEASED} AS released_at, c.word_count FROM chapters c
    WHERE c.novel_id = ? AND ${VISIBLE} ORDER BY c.number ${order} LIMIT ? OFFSET ?`)
    .all(novel.id, CHAPTERS_PER_PAGE, pager.offset);
  const first = db.prepare(`SELECT c.number FROM chapters c WHERE c.novel_id = ? AND ${VISIBLE} ORDER BY c.number ASC LIMIT 1`).get(novel.id);
  const latest = db.prepare(`SELECT c.number, c.title, ${RELEASED} AS released_at FROM chapters c WHERE c.novel_id = ? AND ${VISIBLE} ORDER BY c.number DESC LIMIT 1`).get(novel.id);
  const upcoming = db.prepare(`SELECT c.number, c.title, c.publish_at FROM chapters c WHERE c.novel_id = ? AND NOT ${VISIBLE} ORDER BY c.publish_at ASC LIMIT 5`).all(novel.id);
  const upcomingCount = db.prepare(`SELECT COUNT(*) AS n FROM chapters c WHERE c.novel_id = ? AND NOT ${VISIBLE}`).get(novel.id).n;
  let bookmark = null;
  let myRating = null;
  if (req.user) {
    bookmark = db.prepare(`SELECT b.*, c.number AS last_number FROM bookmarks b LEFT JOIN chapters c ON c.id = b.last_chapter_id
      WHERE b.user_id = ? AND b.novel_id = ?`).get(req.user.id, novel.id) || null;
    myRating = db.prepare('SELECT score FROM ratings WHERE user_id = ? AND novel_id = ?').get(req.user.id, novel.id)?.score || null;
  }
  const words = db.prepare(`SELECT COALESCE(SUM(c.word_count), 0) AS w FROM chapters c WHERE c.novel_id = ? AND ${VISIBLE}`).get(novel.id).w;
  // Rating breakdown: how many 5★, 4★, … votes.
  const dist = Object.fromEntries(db.prepare('SELECT score, COUNT(*) AS n FROM ratings WHERE novel_id = ? GROUP BY score').all(novel.id).map((r) => [r.score, r.n]));
  const reviews = db.prepare(`SELECT rv.*, u.username, u.role, r.score FROM reviews rv JOIN users u ON u.id = rv.user_id
    LEFT JOIN ratings r ON r.user_id = rv.user_id AND r.novel_id = rv.novel_id
    WHERE rv.novel_id = ? ORDER BY rv.updated_at DESC LIMIT 100`).all(novel.id);
  const myReview = req.user ? reviews.find((r) => r.user_id === req.user.id) || null : null;
  const listCounts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM bookmarks WHERE novel_id = ? GROUP BY status').all(novel.id).map((r) => [r.status, r.n]));
  const readers = db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE novel_id = ?').get(novel.id).n;
  const rank = db.prepare(`SELECT COUNT(*) + 1 AS r FROM novels n2 WHERE n2.views > ?`).get(novel.views).r;
  const genres = q.genresForNovel.all(novel.id);
  // "More like this": other novels sharing the most genres.
  const similar = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n
    WHERE n.id != ? AND ${HAS_CHAPTERS} AND EXISTS (SELECT 1 FROM novel_genres ng WHERE ng.novel_id = n.id AND ng.genre_id IN (SELECT genre_id FROM novel_genres WHERE novel_id = ?))
    ORDER BY (SELECT COUNT(*) FROM novel_genres ng WHERE ng.novel_id = n.id AND ng.genre_id IN (SELECT genre_id FROM novel_genres WHERE novel_id = ?)) DESC, n.views DESC
    LIMIT 6`).all(novel.id, novel.id, novel.id);
  res.render('novel', {
    novel, chapters, pager, order, first, latest, upcoming, upcomingCount, bookmark, myRating, words, readers, rank, genres, similar,
    dist, reviews, myReview, listCounts, tab: req.query.tab === 'reviews' ? 'reviews' : 'chapters',
  });
});

router.get('/novel/:slug/chapters.json', loadNovel, (req, res) => {
  const rows = db.prepare(`SELECT c.number, c.volume, c.title FROM chapters c WHERE c.novel_id = ? AND ${VISIBLE} ORDER BY c.number`).all(req.novel.id);
  res.set('Cache-Control', 'public, max-age=60').json(rows);
});

// Add to a library list (status), move between lists, remove, or toggle (no status given).
router.post('/novel/:slug/bookmark', requireLogin, loadNovel, (req, res) => {
  const existing = db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND novel_id = ?').get(req.user.id, req.novel.id);
  const status = req.body.status;
  if (status === 'remove' || (!status && existing)) {
    db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND novel_id = ?').run(req.user.id, req.novel.id);
  } else {
    const list = LIST_LABELS[status] ? status : 'reading';
    db.prepare(`INSERT INTO bookmarks (user_id, novel_id, status) VALUES (?, ?, ?)
      ON CONFLICT(user_id, novel_id) DO UPDATE SET status = excluded.status, updated_at = unixepoch()`).run(req.user.id, req.novel.id, list);
  }
  res.redirect(safeNext(req.body.next) === '/' ? `/novel/${req.novel.slug}` : safeNext(req.body.next));
});

router.post('/novel/:slug/rate', requireLogin, loadNovel, (req, res) => {
  const score = Number(req.body.score);
  if (Number.isInteger(score) && score >= 1 && score <= 5) {
    db.prepare(`INSERT INTO ratings (user_id, novel_id, score) VALUES (?, ?, ?)
      ON CONFLICT(user_id, novel_id) DO UPDATE SET score = excluded.score`).run(req.user.id, req.novel.id, score);
  }
  res.redirect(`/novel/${req.novel.slug}`);
});

router.post('/novel/:slug/review', requireLogin, loadNovel, (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 8000);
  if (body.length >= 20) {
    db.prepare(`INSERT INTO reviews (novel_id, user_id, body) VALUES (?, ?, ?)
      ON CONFLICT(novel_id, user_id) DO UPDATE SET body = excluded.body, updated_at = unixepoch()`).run(req.novel.id, req.user.id, body);
    req.flash('ok', 'Thanks! Your review is posted.');
  } else {
    req.flash('error', 'Reviews need at least 20 characters.');
  }
  res.redirect(`/novel/${req.novel.slug}?tab=reviews#tabs`);
});

router.post('/review/:id/delete', requireLogin, (req, res, next) => {
  const r = db.prepare('SELECT rv.*, n.slug, n.owner_id FROM reviews rv JOIN novels n ON n.id = rv.novel_id WHERE rv.id = ?').get(Number(req.params.id));
  if (!r) return next(notFound());
  if (r.user_id !== req.user.id && req.user.role !== 'admin' && r.owner_id !== req.user.id) return next(Object.assign(new Error('Not allowed.'), { status: 403 }));
  db.prepare('DELETE FROM reviews WHERE id = ?').run(r.id);
  res.redirect(`/novel/${r.slug}?tab=reviews#tabs`);
});

// ---------- Reader ----------
router.get('/novel/:slug/c/:num', loadNovel, (req, res, next) => {
  const novel = req.novel;
  const num = Number(req.params.num);
  const chapter = Number.isFinite(num) ? q.visibleChapterByNumber.get(novel.id, num) : null;
  if (!chapter) return next(notFound('Chapter not found (it may not be released yet).'));

  const prev = db.prepare(`SELECT c.number, c.title FROM chapters c WHERE c.novel_id = ? AND c.number < ? AND ${VISIBLE} ORDER BY c.number DESC LIMIT 1`).get(novel.id, chapter.number);
  const next_ = db.prepare(`SELECT c.number, c.title FROM chapters c WHERE c.novel_id = ? AND c.number > ? AND ${VISIBLE} ORDER BY c.number ASC LIMIT 1`).get(novel.id, chapter.number);
  const upcoming = next_ ? null : db.prepare(`SELECT c.number, c.publish_at FROM chapters c WHERE c.novel_id = ? AND c.number > ? AND NOT ${VISIBLE} ORDER BY c.number ASC LIMIT 1`).get(novel.id, chapter.number);
  const position = db.prepare(`SELECT COUNT(*) AS c FROM chapters c WHERE c.novel_id = ? AND c.number <= ? AND ${VISIBLE}`).get(novel.id, chapter.number).c;

  // Count a view once per session per chapter (keeps the last few ids in the cookie).
  const seen = Array.isArray(req.session.seen) ? req.session.seen : [];
  if (!seen.includes(chapter.id)) {
    recordView(novel.id, chapter.id, req.get('user-agent'));
    chapter.views += 1;
    req.session.seen = [...seen, chapter.id].slice(-40);
  }
  if (req.user) {
    db.prepare('UPDATE bookmarks SET last_chapter_id = ?, updated_at = unixepoch() WHERE user_id = ? AND novel_id = ?')
      .run(chapter.id, req.user.id, novel.id);
  }
  const bookmarked = req.user
    ? !!db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND novel_id = ?').get(req.user.id, novel.id)
    : false;
  const comments = getSettings().comments_enabled === '1'
    ? db.prepare(`SELECT cm.*, u.username, u.role FROM comments cm JOIN users u ON u.id = cm.user_id
        WHERE cm.chapter_id = ? ORDER BY cm.created_at ASC`).all(chapter.id)
    : [];
  const reactionCounts = Object.fromEntries(db.prepare('SELECT emoji, COUNT(*) AS n FROM reactions WHERE chapter_id = ? GROUP BY emoji').all(chapter.id).map((r) => [r.emoji, r.n]));
  const myReaction = req.user ? db.prepare('SELECT emoji FROM reactions WHERE chapter_id = ? AND user_id = ?').get(chapter.id, req.user.id)?.emoji || null : null;
  res.render('reader', { novel, chapter, prev, next: next_, upcoming, position, bookmarked, comments, reactionCounts, myReaction });
});

router.post('/novel/:slug/c/:num/comment', requireLogin, loadNovel, (req, res, next) => {
  if (getSettings().comments_enabled !== '1') return next(notFound());
  const chapter = q.visibleChapterByNumber.get(req.novel.id, Number(req.params.num));
  if (!chapter) return next(notFound('Chapter not found.'));
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (body) db.prepare('INSERT INTO comments (chapter_id, user_id, body) VALUES (?, ?, ?)').run(chapter.id, req.user.id, body);
  res.redirect(`/novel/${req.novel.slug}/c/${req.params.num}#comments`);
});

// React to a chapter (click the same emoji again to take it back). Answers JSON for the reader page.
router.post('/novel/:slug/c/:num/react', requireLogin, loadNovel, (req, res, next) => {
  const chapter = q.visibleChapterByNumber.get(req.novel.id, Number(req.params.num));
  if (!chapter) return next(notFound('Chapter not found.'));
  const emoji = REACTIONS[req.body.emoji] ? req.body.emoji : null;
  const current = db.prepare('SELECT emoji FROM reactions WHERE chapter_id = ? AND user_id = ?').get(chapter.id, req.user.id)?.emoji;
  if (!emoji || current === emoji) {
    db.prepare('DELETE FROM reactions WHERE chapter_id = ? AND user_id = ?').run(chapter.id, req.user.id);
  } else {
    db.prepare(`INSERT INTO reactions (chapter_id, user_id, emoji) VALUES (?, ?, ?)
      ON CONFLICT(chapter_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = unixepoch()`).run(chapter.id, req.user.id, emoji);
  }
  const counts = Object.fromEntries(db.prepare('SELECT emoji, COUNT(*) AS n FROM reactions WHERE chapter_id = ? GROUP BY emoji').all(chapter.id).map((r) => [r.emoji, r.n]));
  const mine = !emoji || current === emoji ? null : emoji;
  if (req.accepts(['html', 'json']) === 'json') return res.json({ counts, mine });
  res.redirect(`/novel/${req.novel.slug}/c/${req.params.num}#reactions`);
});

// Report a problem with a chapter. Works without an account (limited per session).
router.post('/novel/:slug/c/:num/report', loadNovel, (req, res, next) => {
  const chapter = q.visibleChapterByNumber.get(req.novel.id, Number(req.params.num));
  if (!chapter) return next(notFound('Chapter not found.'));
  const sent = Number(req.session.reports) || 0;
  const kind = REPORT_KINDS[req.body.kind] ? req.body.kind : 'other';
  const message = String(req.body.message || '').trim().slice(0, 2000);
  const quote = String(req.body.quote || '').trim().slice(0, 1000);
  let ok = false;
  if (sent < 20 && (message || quote)) {
    db.prepare('INSERT INTO reports (chapter_id, user_id, kind, quote, message) VALUES (?, ?, ?, ?, ?)')
      .run(chapter.id, req.user?.id ?? null, kind, quote, message);
    req.session.reports = sent + 1;
    ok = true;
  }
  if (req.accepts(['html', 'json']) === 'json') return res.status(ok ? 200 : 400).json({ ok });
  req.flash(ok ? 'ok' : 'error', ok ? 'Thanks! The translator has been notified.' : 'Please describe the problem.');
  res.redirect(`/novel/${req.novel.slug}/c/${req.params.num}`);
});

router.post('/comment/:id/delete', requireLogin, (req, res, next) => {
  const c = db.prepare(`SELECT cm.*, ch.number, n.slug, n.owner_id FROM comments cm JOIN chapters ch ON ch.id = cm.chapter_id
    JOIN novels n ON n.id = ch.novel_id WHERE cm.id = ?`).get(Number(req.params.id));
  if (!c) return next(notFound());
  const allowed = c.user_id === req.user.id || req.user.role === 'admin' || c.owner_id === req.user.id;
  if (!allowed) return next(Object.assign(new Error('Not allowed.'), { status: 403 }));
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.redirect(`/novel/${c.slug}/c/${formatNumber(c.number)}#comments`);
});

// ---------- Library & history ----------
router.get('/library', requireLogin, (req, res) => {
  const list = LIST_LABELS[req.query.list] ? req.query.list : 'all';
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM bookmarks WHERE user_id = ? GROUP BY status').all(req.user.id).map((r) => [r.status, r.n]));
  const items = db.prepare(`
    SELECT ${NOVEL_COLUMNS}, b.updated_at AS read_at, b.status AS list, c.number AS last_number
    FROM bookmarks b JOIN novels n ON n.id = b.novel_id LEFT JOIN chapters c ON c.id = b.last_chapter_id
    WHERE b.user_id = ? ${list === 'all' ? '' : 'AND b.status = ?'} ORDER BY last_release DESC`).all(req.user.id, ...(list === 'all' ? [] : [list]));
  res.render('library', { items, list, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
});

// ---------- User profiles ----------
router.get('/user/:name', (req, res, next) => {
  const profile = db.prepare('SELECT id, username, role, is_owner, created_at FROM users WHERE username = ? COLLATE NOCASE').get(req.params.name);
  if (!profile) return next(notFound('User not found.'));
  const translated = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE n.owner_id = ? ORDER BY last_release DESC`).all(profile.id);
  const lists = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM bookmarks WHERE user_id = ? GROUP BY status').all(profile.id).map((r) => [r.status, r.n]));
  const reading = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM bookmarks b JOIN novels n ON n.id = b.novel_id
    WHERE b.user_id = ? AND b.status = 'reading' ORDER BY b.updated_at DESC LIMIT 12`).all(profile.id);
  const reviews = db.prepare(`SELECT rv.*, n.title AS novel_title, n.slug, r.score FROM reviews rv JOIN novels n ON n.id = rv.novel_id
    LEFT JOIN ratings r ON r.user_id = rv.user_id AND r.novel_id = rv.novel_id WHERE rv.user_id = ? ORDER BY rv.updated_at DESC LIMIT 10`).all(profile.id);
  const comments = db.prepare(`SELECT cm.body, cm.created_at, c.number, c.title, n.title AS novel_title, n.slug FROM comments cm
    JOIN chapters c ON c.id = cm.chapter_id JOIN novels n ON n.id = c.novel_id WHERE cm.user_id = ? ORDER BY cm.created_at DESC LIMIT 10`).all(profile.id);
  const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM comments WHERE user_id = ?) AS comments,
    (SELECT COUNT(*) FROM ratings WHERE user_id = ?) AS ratings, (SELECT COUNT(*) FROM reviews WHERE user_id = ?) AS reviews`).get(profile.id, profile.id, profile.id);
  res.render('user', { profile, translated, lists, reading, reviews, comments, counts });
});

// Reading history is kept in the browser (works without an account); the page fills itself in.
router.get('/history', (req, res) => res.render('history'));

// ---------- Feeds & SEO ----------
function rss(req, res, { title, link, description, items }) {
  const base = res.locals.baseUrl;
  const body = items.map((c) => `
    <item>
      <title>${xmlEscape(`${c.novel_title} — ${chapterLabel(c)}`)}</title>
      <link>${base}/novel/${c.slug}/c/${formatNumber(c.number)}</link>
      <guid isPermaLink="false">chapter-${c.id}</guid>
      <pubDate>${new Date(c.released_at * 1000).toUTCString()}</pubDate>
    </item>`).join('');
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${xmlEscape(title)}</title>
  <link>${base}${link}</link>
  <description>${xmlEscape(description)}</description>${body}
</channel></rss>`);
}

const FEED_SQL = `SELECT c.id, c.number, c.title, ${RELEASED} AS released_at, n.title AS novel_title, n.slug
  FROM chapters c JOIN novels n ON n.id = c.novel_id WHERE ${VISIBLE}`;

router.get('/rss.xml', (req, res) => {
  const s = getSettings();
  const items = db.prepare(`${FEED_SQL} ORDER BY released_at DESC LIMIT 50`).all();
  rss(req, res, { title: s.site_name, link: '/', description: s.site_tagline, items });
});

router.get('/novel/:slug/rss.xml', loadNovel, (req, res) => {
  const items = db.prepare(`${FEED_SQL} AND c.novel_id = ? ORDER BY released_at DESC LIMIT 50`).all(req.novel.id);
  rss(req, res, { title: `${req.novel.title} — ${getSettings().site_name}`, link: `/novel/${req.novel.slug}`, description: req.novel.description.slice(0, 300), items });
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /login\nDisallow: /register\nDisallow: /library\nSitemap: ${res.locals.baseUrl}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const base = res.locals.baseUrl;
  const novels = db.prepare(`SELECT n.slug,
    COALESCE((SELECT MAX(${RELEASED}) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}), n.updated_at) AS lastmod FROM novels n`).all();
  const chapters = db.prepare(`SELECT n.slug, c.number, ${RELEASED} AS lastmod FROM chapters c JOIN novels n ON n.id = c.novel_id
    WHERE ${VISIBLE} ORDER BY c.id DESC LIMIT 45000`).all();
  const url = (loc, t) => `<url><loc>${xmlEscape(base + loc)}</loc><lastmod>${new Date(t * 1000).toISOString().slice(0, 10)}</lastmod></url>`;
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${xmlEscape(base)}/</loc></url>
${novels.map((n) => url(`/novel/${n.slug}`, n.lastmod)).join('\n')}
${chapters.map((c) => url(`/novel/${c.slug}/c/${formatNumber(c.number)}`, c.lastmod)).join('\n')}
</urlset>`);
});

// ---------- Accounts ----------
router.get('/login', (req, res) => res.render('login', { mode: 'login', error: null, next: safeNext(req.query.next), username: '' }));
router.get('/register', (req, res) => res.render('login', { mode: 'register', error: null, next: safeNext(req.query.next), username: '' }));

router.post('/login', (req, res) => {
  try {
    req.session.uid = login(req.body.username, req.body.password);
    res.redirect(safeNext(req.body.next));
  } catch (err) {
    res.status(400).render('login', { mode: 'login', error: err.message, next: safeNext(req.body.next), username: req.body.username || '' });
  }
});

router.post('/register', (req, res) => {
  try {
    req.session.uid = register(req.body.username, req.body.password);
    res.redirect(safeNext(req.body.next));
  } catch (err) {
    res.status(err.status || 400).render('login', { mode: 'register', error: err.message, next: safeNext(req.body.next), username: req.body.username || '' });
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

module.exports = { router, safeNext };
