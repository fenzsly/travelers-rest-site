const express = require('express');
const { db } = require('../db');
const { q, NOVEL_COLUMNS, login, register } = require('../queries');
const { verifyCsrf, requireLogin } = require('../auth');
const { getSettings } = require('../settings');
const { paginate, STATUS_LABELS } = require('../util');

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

// ---------- Home ----------
router.get('/', (req, res) => {
  const popular = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n ORDER BY n.views DESC LIMIT 12`).all();
  const updated = db.prepare(`
    SELECT ${NOVEL_COLUMNS} FROM novels n
    WHERE EXISTS (SELECT 1 FROM chapters c WHERE c.novel_id = n.id)
    ORDER BY n.updated_at DESC LIMIT 15`).all();
  const recentChapters = db.prepare(
    'SELECT id, number, title, created_at FROM chapters WHERE novel_id = ? ORDER BY created_at DESC, number DESC LIMIT 3');
  for (const n of updated) n.recent = recentChapters.all(n.id);
  const fresh = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n ORDER BY n.created_at DESC LIMIT 6`).all();
  const topRated = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE rating_count > 0 ORDER BY rating DESC, rating_count DESC LIMIT 6`).all();
  res.render('home', { popular, updated, fresh, topRated, genres: q.allGenres.all() });
});

// ---------- Catalog / search ----------
const SORTS = {
  updated: 'n.updated_at DESC',
  new: 'n.created_at DESC',
  popular: 'n.views DESC',
  rating: 'rating IS NULL, rating DESC, rating_count DESC',
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
  const sort = SORTS[req.query.sort] ? req.query.sort : 'updated';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM novels n ${whereSql}`).get(...params).c;
  const pager = paginate(total, Number(req.query.page), PER_PAGE);
  const novels = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n ${whereSql} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`)
    .all(...params, PER_PAGE, pager.offset);
  const genres = q.allGenres.all();
  res.render('catalog', {
    novels, pager, genres, search, genre, status, sort,
    activeGenre: genres.find((g) => g.slug === genre),
  });
});

router.get('/search', (req, res) => res.redirect(`/novels?q=${encodeURIComponent(req.query.q || '')}`));
router.get('/genre/:slug', (req, res) => res.redirect(`/novels?genre=${encodeURIComponent(req.params.slug)}`));

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
  const chapters = db.prepare(`SELECT id, number, title, created_at, word_count FROM chapters WHERE novel_id = ? ORDER BY number ${order} LIMIT ? OFFSET ?`)
    .all(novel.id, CHAPTERS_PER_PAGE, pager.offset);
  const first = db.prepare('SELECT number FROM chapters WHERE novel_id = ? ORDER BY number ASC LIMIT 1').get(novel.id);
  const latest = db.prepare('SELECT number, title, created_at FROM chapters WHERE novel_id = ? ORDER BY number DESC LIMIT 1').get(novel.id);
  let bookmark = null;
  let myRating = null;
  if (req.user) {
    bookmark = db.prepare(`SELECT b.*, c.number AS last_number FROM bookmarks b LEFT JOIN chapters c ON c.id = b.last_chapter_id
      WHERE b.user_id = ? AND b.novel_id = ?`).get(req.user.id, novel.id) || null;
    myRating = db.prepare('SELECT score FROM ratings WHERE user_id = ? AND novel_id = ?').get(req.user.id, novel.id)?.score || null;
  }
  const words = db.prepare('SELECT COALESCE(SUM(word_count), 0) AS w FROM chapters WHERE novel_id = ?').get(novel.id).w;
  res.render('novel', {
    novel, chapters, pager, order, first, latest, bookmark, myRating, words,
    genres: q.genresForNovel.all(novel.id),
  });
});

router.get('/novel/:slug/chapters.json', loadNovel, (req, res) => {
  const rows = db.prepare('SELECT number, title FROM chapters WHERE novel_id = ? ORDER BY number').all(req.novel.id);
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
  const chapter = Number.isFinite(num) ? q.chapterByNumber.get(novel.id, num) : null;
  if (!chapter) return next(notFound('Chapter not found.'));

  const prev = db.prepare('SELECT number, title FROM chapters WHERE novel_id = ? AND number < ? ORDER BY number DESC LIMIT 1').get(novel.id, chapter.number);
  const next_ = db.prepare('SELECT number, title FROM chapters WHERE novel_id = ? AND number > ? ORDER BY number ASC LIMIT 1').get(novel.id, chapter.number);
  const position = db.prepare('SELECT COUNT(*) AS c FROM chapters WHERE novel_id = ? AND number <= ?').get(novel.id, chapter.number).c;

  // Count a view once per session per chapter (keeps the last few ids in the cookie).
  const seen = Array.isArray(req.session.seen) ? req.session.seen : [];
  if (!seen.includes(chapter.id)) {
    db.prepare('UPDATE chapters SET views = views + 1 WHERE id = ?').run(chapter.id);
    db.prepare('UPDATE novels SET views = views + 1 WHERE id = ?').run(novel.id);
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
  res.render('reader', { novel, chapter, prev, next: next_, position, bookmarked, comments });
});

router.post('/novel/:slug/c/:num/comment', requireLogin, loadNovel, (req, res, next) => {
  if (getSettings().comments_enabled !== '1') return next(notFound());
  const chapter = q.chapterByNumber.get(req.novel.id, Number(req.params.num));
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
  res.redirect(`/novel/${c.slug}/c/${c.number}#comments`);
});

// ---------- Library ----------
router.get('/library', requireLogin, (req, res) => {
  const items = db.prepare(`
    SELECT ${NOVEL_COLUMNS}, b.updated_at AS read_at, c.number AS last_number
    FROM bookmarks b JOIN novels n ON n.id = b.novel_id LEFT JOIN chapters c ON c.id = b.last_chapter_id
    WHERE b.user_id = ? ORDER BY n.updated_at DESC`).all(req.user.id);
  res.render('library', { items });
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
