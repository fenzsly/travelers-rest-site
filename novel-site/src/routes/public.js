const express = require('express');
const { db } = require('../db');
const { q, NOVEL_COLUMNS, VISIBLE, RELEASED, recordView, login, register } = require('../queries');
const { verifyCsrf, requireLogin } = require('../auth');
const { getSettings } = require('../settings');
const { paginate, chapterLabel, formatNumber, STATUS_LABELS } = require('../util');

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
  next();
});

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
  const chapters = db.prepare(`SELECT c.id, c.number, c.title, ${RELEASED} AS released_at, c.word_count FROM chapters c
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
  });
});

router.get('/novel/:slug/chapters.json', loadNovel, (req, res) => {
  const rows = db.prepare(`SELECT c.number, c.title FROM chapters c WHERE c.novel_id = ? AND ${VISIBLE} ORDER BY c.number`).all(req.novel.id);
  res.set('Cache-Control', 'public, max-age=60').json(rows);
});

router.post('/novel/:slug/bookmark', requireLogin, loadNovel, (req, res) => {
  const existing = db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND novel_id = ?').get(req.user.id, req.novel.id);
  if (existing) {
    db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND novel_id = ?').run(req.user.id, req.novel.id);
  } else {
    db.prepare('INSERT INTO bookmarks (user_id, novel_id) VALUES (?, ?)').run(req.user.id, req.novel.id);
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
  res.render('reader', { novel, chapter, prev, next: next_, upcoming, position, bookmarked, comments });
});

router.post('/novel/:slug/c/:num/comment', requireLogin, loadNovel, (req, res, next) => {
  if (getSettings().comments_enabled !== '1') return next(notFound());
  const chapter = q.visibleChapterByNumber.get(req.novel.id, Number(req.params.num));
  if (!chapter) return next(notFound('Chapter not found.'));
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (body) db.prepare('INSERT INTO comments (chapter_id, user_id, body) VALUES (?, ?, ?)').run(chapter.id, req.user.id, body);
  res.redirect(`/novel/${req.novel.slug}/c/${req.params.num}#comments`);
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
  const items = db.prepare(`
    SELECT ${NOVEL_COLUMNS}, b.updated_at AS read_at, c.number AS last_number
    FROM bookmarks b JOIN novels n ON n.id = b.novel_id LEFT JOIN chapters c ON c.id = b.last_chapter_id
    WHERE b.user_id = ? ORDER BY last_release DESC`).all(req.user.id);
  res.render('library', { items });
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
