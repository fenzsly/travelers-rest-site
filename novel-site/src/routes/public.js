const express = require('express');
const { db } = require('../db');
const { q, NOVEL_COLUMNS, VISIBLE, RELEASED, login, register, checkEmail } = require('../queries');
const mail = require('../mail');
const { savePrefs } = require('../prefs');
const requests = require('../requests');
const updateRequests = require('../update-requests');
const guard = require('../guard');
const notifications = require('../notifications');
const security = require('../security');
const visitors = require('../visitors');
const { hashPassword, verifyPassword } = require('../auth');
const { verifyCsrf, requireLogin } = require('../auth');
const { getSettings } = require('../settings');
const seo = require('../seo');
const u = require('../util');
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
  res.locals.seoLib = seo;
  // Pages that don't set their own SEO info are kept out of search results.
  res.locals.seo = { noindex: true };
  res.locals.navGenres = q.allGenres.all();
  res.locals.updates = req.user ? libraryUpdates(req.user.id) : [];
  res.locals.notes = req.user ? notifications.unread(req.user.id) : [];
  // (Unique visitors are counted by POST /beacon, which only real browsers send: see visitors.js.)
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
  // Newest chapter comments and novel reviews from anywhere on the site (never on unreleased chapters).
  const latestComments = getSettings().comments_enabled === '1' ? db.prepare(`
    SELECT * FROM (
      SELECT 'comment' AS kind, cm.id, cm.body, cm.created_at, u.username, u.role, n.slug, n.title AS novel_title, c.number, c.volume, c.title AS chapter_title
      FROM comments cm JOIN users u ON u.id = cm.user_id JOIN chapters c ON c.id = cm.chapter_id JOIN novels n ON n.id = c.novel_id
      WHERE ${VISIBLE}
      UNION ALL
      SELECT 'review', rv.id, rv.body, rv.updated_at, u.username, u.role, n.slug, n.title, NULL, NULL, NULL
      FROM reviews rv JOIN users u ON u.id = rv.user_id JOIN novels n ON n.id = rv.novel_id
    ) ORDER BY created_at DESC LIMIT 8`).all() : [];
  const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM novels) AS novels,
    (SELECT COUNT(*) FROM chapters c WHERE ${VISIBLE}) AS chapters,
    (SELECT COALESCE(SUM(views), 0) FROM novels) AS views`).get();
  const s = getSettings();
  const topRequests = requests.topThisWeek(5);
  res.render('home', {
    popular, updated, fresh, topRated, trending, completed, totals, latestComments, topRequests, genres: q.allGenres.all(),
    seo: {
      // Include the spaced spelling too ("Traveller MTL"): search engines treat "TravellerMTL" as one word.
      title: (() => {
        const alt = (s.site_alternate_names || '').split(',').map((x) => x.trim()).find((x) => x && !/\./.test(x) && x.toLowerCase() !== s.site_name.toLowerCase());
        return `${s.site_name}${alt ? ` (${alt})` : ''} — ${s.site_tagline}`;
      })(),
      description: s.site_description,
      canonical: `${res.locals.baseUrl}/`,
      jsonld: seo.websiteSchema(res.locals.baseUrl, s),
    },
  });
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
  const activeGenre = genres.find((g) => g.slug === genre);
  const site = getSettings().site_name;
  // Genre listings are worth indexing; search results, tag and status filters and re-sorted lists are not.
  const indexable = !search && !tag && !status && (sort === 'updated' || sort === 'popular' || sort === 'trending');
  const pageUrl = (p) => `${res.locals.baseUrl}/novels${new URLSearchParams(Object.entries({ genre, sort: sort === 'updated' ? '' : sort, page: p > 1 ? p : '' }).filter(([, v]) => v)).toString().replace(/^(.)/, '?$1')}`;
  const label = activeGenre ? `${activeGenre.name} Novels` : sort === 'trending' ? 'Trending Novels' : sort === 'popular' ? 'Most Popular Novels' : 'All Novels';
  res.render('catalog', {
    novels, pager, genres, search, genre, status, sort, tag, activeGenre,
    seo: {
      title: search ? `Search: ${search} | ${site}` : `${label}${pager.current > 1 ? ` (page ${pager.current})` : ''} — Read Online | ${site}`,
      description: activeGenre
        ? `Read ${activeGenre.name.toLowerCase()} web novels translated into English on ${site}. ${pager.total} ${activeGenre.name.toLowerCase()} novels, updated regularly. Free to read online.`
        : `Browse ${pager.total} translated web novels on ${site}: fantasy, xianxia, romance, isekai and more. Sort by latest updates, popularity or rating.`,
      canonical: indexable ? pageUrl(pager.current) : undefined,
      noindex: !indexable,
      prev: indexable && pager.current > 1 ? pageUrl(pager.current - 1) : undefined,
      next: indexable && pager.current < pager.pages ? pageUrl(pager.current + 1) : undefined,
    },
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
  const updateStatus = updateRequests.status(novel.id, req.user?.id);
  res.render('novel', {
    novel, chapters, pager, order, first, latest, upcoming, upcomingCount, bookmark, myRating, words, readers, rank, genres, similar, updateStatus,
    dist, reviews, myReview, listCounts, tab: req.query.tab === 'reviews' ? 'reviews' : 'chapters',
    seo: {
      title: novel.seo_title || `${novel.title} Novel — Read Online${novel.chapter_count ? ` (${novel.chapter_count} Chapters)` : ''} | ${getSettings().site_name}`,
      ogTitle: novel.seo_title || novel.title,
      // Mention alternative titles: readers often search for the original or a shortened name.
      description: novel.seo_description || seo.excerpt(`Read ${novel.title}${novel.alt_titles ? ` (${novel.alt_titles.split('\n').map((t) => t.trim()).filter(Boolean).slice(0, 2).join(', ')})` : ''} online in English on ${getSettings().site_name}. ${seo.plainText(novel.description)}`),
      // Other orderings/tabs of the same page point search engines at the main URL.
      canonical: `${res.locals.baseUrl}/novel/${novel.slug}${pager.current > 1 ? `?page=${pager.current}` : ''}`,
      image: novel.cover ? `${res.locals.baseUrl}/uploads/covers/${novel.cover}` : undefined,
      type: 'book',
      jsonld: seo.bookSchema(res.locals.baseUrl, novel, genres),
      feed: { title: `${novel.title} — new chapters`, href: `/novel/${novel.slug}/rss.xml` },
    },
  });
});

// "Request update": logged-in readers ask for new chapters; staff are told by email and in the admin panel.
router.post('/novel/:slug/request-update', requireLogin, loadNovel, (req, res) => {
  const json = req.accepts(['html', 'json']) === 'json';
  let result;
  try {
    result = updateRequests.requestUpdate(req.novel, req.user.id);
  } catch (err) {
    if (err.status !== 400) throw err;
    if (json) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
    return res.redirect(`/novel/${req.novel.slug}`);
  }
  if (result.added) {
    const admin = res.locals.adminUrl || '/admin';
    const link = `${/^https?:/.test(admin) ? admin : res.locals.baseUrl + admin}/update-requests`;
    updateRequests.notifyStaff(req.novel, result.waiting, link).catch((err) => console.error(err));
  }
  if (json) return res.json(result);
  req.flash('ok', result.added ? 'Thanks! The team has been told you want more chapters.' : 'You’ve already asked. We’ll let the team know again after the next chapter.');
  res.redirect(`/novel/${req.novel.slug}`);
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
router.get('/novel/:slug/c/:num', loadNovel, async (req, res, next) => {
  const novel = req.novel;
  const num = Number(req.params.num);
  const chapter = Number.isFinite(num) ? q.visibleChapterByNumber.get(novel.id, num) : null;
  if (!chapter) return next(notFound('Chapter not found (it may not be released yet).'));

  // Scraper check: count every chapter download (self-declared bots separately).
  visitors.bump(visitors.isBot(req) ? 'bot_loads' : 'chapter_loads');

  // Guests past the free-chapter limit (and anything reading too fast) see a sign-up page instead.
  const blocked = await guard.checkChapter(req, chapter.id);
  if (blocked) {
    visitors.bump('gate_hits');
    const title = `${novel.title} ${u.chapterLabel(chapter)}`;
    return res.status(blocked.gate === 'slow' ? 429 : 200).render('gate', {
      novel, chapter, gate: blocked.gate, limit: blocked.limit,
      teaser: seo.excerpt(seo.plainText(chapter.content), 400),
      seo: { title: `${title} | ${getSettings().site_name}`, noindex: true },
    });
  }

  const prev = db.prepare(`SELECT c.number, c.title FROM chapters c WHERE c.novel_id = ? AND c.number < ? AND ${VISIBLE} ORDER BY c.number DESC LIMIT 1`).get(novel.id, chapter.number);
  const next_ = db.prepare(`SELECT c.number, c.title FROM chapters c WHERE c.novel_id = ? AND c.number > ? AND ${VISIBLE} ORDER BY c.number ASC LIMIT 1`).get(novel.id, chapter.number);
  const upcoming = next_ ? null : db.prepare(`SELECT c.number, c.publish_at FROM chapters c WHERE c.novel_id = ? AND c.number > ? AND NOT ${VISIBLE} ORDER BY c.number ASC LIMIT 1`).get(novel.id, chapter.number);
  const position = db.prepare(`SELECT COUNT(*) AS c FROM chapters c WHERE c.novel_id = ? AND c.number <= ? AND ${VISIBLE}`).get(novel.id, chapter.number).c;

  // Remember which chapters this browser opened (for the guest free-chapter count).
  // Views, readers and visitors are counted by the page's beacon instead, so scrapers don't inflate them.
  const seen = Array.isArray(req.session.seen) ? req.session.seen : [];
  if (!seen.includes(chapter.id)) req.session.seen = [...seen, chapter.id].slice(-40);
  if (req.user) {
    db.prepare('UPDATE bookmarks SET last_chapter_id = ?, updated_at = unixepoch() WHERE user_id = ? AND novel_id = ?')
      .run(chapter.id, req.user.id, novel.id);
  }
  const bookmarked = req.user
    ? !!db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND novel_id = ?').get(req.user.id, novel.id)
    : false;
  const allComments = getSettings().comments_enabled === '1'
    ? db.prepare(`SELECT cm.*, u.username, u.role FROM comments cm JOIN users u ON u.id = cm.user_id
        WHERE cm.chapter_id = ? ORDER BY cm.created_at ASC, cm.id ASC`).all(chapter.id)
    : [];
  // Top-level comments, each with its replies (oldest first, so a chain reads top to bottom).
  const comments = allComments.filter((c) => !c.parent_id);
  for (const c of comments) c.replies = allComments.filter((r) => r.parent_id === c.id);
  const reactionCounts = Object.fromEntries(db.prepare('SELECT emoji, COUNT(*) AS n FROM reactions WHERE chapter_id = ? GROUP BY emoji').all(chapter.id).map((r) => [r.emoji, r.n]));
  const myReaction = req.user ? db.prepare('SELECT emoji FROM reactions WHERE chapter_id = ? AND user_id = ?').get(chapter.id, req.user.id)?.emoji || null : null;
  const base = `${res.locals.baseUrl}/novel/${novel.slug}/c/`;
  res.render('reader', {
    novel, chapter, prev, next: next_, upcoming, position, bookmarked, comments, reactionCounts, myReaction,
    seo: {
      title: `${novel.title} ${u.chapterLabel(chapter)} | ${getSettings().site_name}`,
      ogTitle: `${novel.title} — ${u.chapterLabel(chapter)}`,
      description: seo.excerpt(`${u.chapterLabel(chapter)}. ${seo.plainText(chapter.content)}`),
      canonical: base + u.formatNumber(chapter.number),
      prev: prev ? base + u.formatNumber(prev.number) : undefined,
      next: next_ ? base + u.formatNumber(next_.number) : undefined,
      image: novel.cover ? `${res.locals.baseUrl}/uploads/covers/${novel.cover}` : undefined,
      type: 'article',
      jsonld: seo.chapterSchema(res.locals.baseUrl, novel, chapter),
    },
  });
});

router.post('/novel/:slug/c/:num/comment', requireLogin, loadNovel, (req, res, next) => {
  if (getSettings().comments_enabled !== '1') return next(notFound());
  const chapter = q.visibleChapterByNumber.get(req.novel.id, Number(req.params.num));
  if (!chapter) return next(notFound('Chapter not found.'));
  const body = String(req.body.body || '').trim().slice(0, 4000);
  const here = `/novel/${req.novel.slug}/c/${formatNumber(chapter.number)}`;
  if (!body) return res.redirect(`${here}#comments`);
  // A reply: attach it to the top comment of the thread, so chains stay together.
  let parent = null;
  if (req.body.parent_id) {
    parent = db.prepare('SELECT id, parent_id, user_id FROM comments WHERE id = ? AND chapter_id = ?').get(Number(req.body.parent_id), chapter.id);
    if (!parent) {
      req.flash('error', 'That comment was deleted, so your reply couldn’t be posted.');
      return res.redirect(`${here}#comments`);
    }
  }
  const rootId = parent ? parent.parent_id || parent.id : null;
  const id = Number(db.prepare('INSERT INTO comments (chapter_id, user_id, body, parent_id) VALUES (?, ?, ?, ?)')
    .run(chapter.id, req.user.id, body, rootId).lastInsertRowid);
  if (parent) {
    // Tell the person being replied to, and the thread starter if that's someone else.
    const root = parent.parent_id ? db.prepare('SELECT user_id FROM comments WHERE id = ?').get(rootId) : parent;
    const where = `${req.novel.title} ${chapterLabel(chapter)}: “${body.slice(0, 120)}”`;
    const send = (uid, text) => notifications.notify(uid, { actorId: req.user.id, kind: 'reply', commentId: id, link: `${here}#c${id}`, text });
    send(parent.user_id, `${req.user.username} replied to your comment on ${where}`);
    if (root && root.user_id !== parent.user_id) send(root.user_id, `${req.user.username} replied in your comment’s thread on ${where}`);
  }
  res.redirect(`${here}#c${id}`);
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
// Error reports ("typo in this chapter") from logged-in readers. They go to Admin → Fixes.
router.post('/novel/:slug/c/:num/report', loadNovel, (req, res, next) => {
  const json = req.accepts(['html', 'json']) === 'json';
  const back = `/novel/${req.novel.slug}/c/${req.params.num}`;
  if (!req.user) {
    if (json) return res.status(401).json({ error: 'Please log in to report errors.' });
    return res.redirect(`/login?next=${encodeURIComponent(`${back}#report-error`)}`);
  }
  const chapter = q.visibleChapterByNumber.get(req.novel.id, Number(req.params.num));
  if (!chapter) return next(notFound('Chapter not found.'));
  const kind = REPORT_KINDS[req.body.kind] ? req.body.kind : 'other';
  const message = String(req.body.message || '').trim().slice(0, 2000);
  const quote = String(req.body.quote || '').trim().slice(0, 1000);
  const today = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND created_at >= unixepoch() - 86400').get(req.user.id).n;
  let error = null;
  if (!message && !quote) error = 'Please describe the error.';
  else if (today >= 30) error = 'You’ve sent a lot of reports today. Thank you! Please try again tomorrow.';
  else {
    db.prepare('INSERT INTO reports (chapter_id, user_id, kind, quote, message) VALUES (?, ?, ?, ?, ?)')
      .run(chapter.id, req.user.id, kind, quote, message);
  }
  if (json) return res.status(error ? 400 : 200).json(error ? { error } : { ok: true });
  req.flash(error ? 'error' : 'ok', error || 'Thanks! Your report was sent to the team to fix.');
  res.redirect(back);
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

// ---------- Notifications (the bell) ----------
router.get('/notifications', requireLogin, (req, res) => {
  res.render('notifications', { items: notifications.recent(req.user.id), seo: { title: `Notifications | ${getSettings().site_name}`, noindex: true } });
});
router.get('/notifications/:id', requireLogin, (req, res) => {
  const link = notifications.open(req.user.id, req.params.id);
  res.redirect(link && link.startsWith('/') && !link.startsWith('//') ? link : '/notifications');
});
router.post('/notifications/read', requireLogin, (req, res) => {
  notifications.markAllRead(req.user.id);
  res.redirect(safeNext(req.body.next) === '/' ? '/notifications' : safeNext(req.body.next));
});

// ---------- Library & history ----------
router.get('/library', requireLogin, (req, res) => {
  const list = LIST_LABELS[req.query.list] ? req.query.list : 'all';
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM bookmarks WHERE user_id = ? GROUP BY status').all(req.user.id).map((r) => [r.status, r.n]));
  const items = db.prepare(`
    SELECT ${NOVEL_COLUMNS}, b.updated_at AS read_at, b.status AS list, c.number AS last_number
    FROM bookmarks b JOIN novels n ON n.id = b.novel_id LEFT JOIN chapters c ON c.id = b.last_chapter_id
    WHERE b.user_id = ? ${list === 'all' ? '' : 'AND b.status = ?'} ORDER BY last_release DESC`).all(req.user.id, ...(list === 'all' ? [] : [list]));
  res.render('library', { items, list, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), seo: { title: `My library | ${getSettings().site_name}`, noindex: true } });
});

// ---------- Novel requests ----------
const REQUEST_TABS = { week: 'Weekly leaderboard', all: 'All time', new: 'Newest', added: 'Added' };
const REQUESTS_PER_PAGE = 30;

router.get('/requests', (req, res) => {
  const tab = REQUEST_TABS[req.query.tab] ? req.query.tab : 'week';
  const statuses = tab === 'added' ? ['added'] : ['open', 'planned'];
  const pager = paginate(requests.countRequests(statuses), Number(req.query.page), REQUESTS_PER_PAGE);
  const items = requests.listRequests({ statuses, sort: tab === 'added' ? 'new' : tab, userId: req.user?.id || 0, limit: REQUESTS_PER_PAGE, offset: pager.offset });
  const mine = req.user ? db.prepare(`SELECT r.id, r.title, r.status, r.reply, n.slug AS novel_slug FROM novel_requests r LEFT JOIN novels n ON n.id = r.novel_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 10`).all(req.user.id) : [];
  const s = getSettings();
  const form = req.session.requestForm || {};
  const error = req.session.requestError || null;
  req.session.requestForm = null;
  req.session.requestError = null;
  res.render('requests', {
    items, tab, tabs: REQUEST_TABS, pager, mine, languages: requests.LANGUAGES, statusLabels: requests.REQUEST_STATUS, form, error,
    week: requests.weekOf(), pastWeeks: tab === 'week' ? requests.pastWeeks(4) : [],
    seo: {
      title: `Novel requests — vote for the next translation | ${s.site_name}`,
      description: `Request a web novel for ${s.site_name} to translate and vote for others. The most-voted novels each week are ranked here.`,
      canonical: `${res.locals.baseUrl}/requests`,
      noindex: tab !== 'week' || pager.current > 1,
    },
  });
});

router.post('/requests', requireLogin, (req, res) => {
  try {
    const { request, duplicate, novel } = requests.createRequest(req.user.id, req.body);
    if (novel) {
      req.flash('ok', `Good news: “${novel.title}” is already on the site!`);
      return res.redirect(`/novel/${novel.slug}`);
    }
    req.flash('ok', duplicate
      ? `“${request.title}” was already requested, so we added your vote to it.`
      : `Thanks! “${request.title}” is now on the list. Share it so others can vote.`);
    res.redirect(`/requests?tab=${duplicate ? 'week' : 'new'}#r${request.id}`);
  } catch (err) {
    if (err.status !== 400) throw err;
    req.session.requestError = err.message;
    req.session.requestForm = Object.fromEntries(['title', 'author', 'language', 'link', 'note'].map((k) => [k, String(req.body[k] || '').slice(0, k === 'note' ? 600 : 300)]));
    res.redirect('/requests#request-form');
  }
});

router.post('/requests/:id/vote', requireLogin, (req, res) => {
  let result;
  try {
    result = requests.toggleVote(req.params.id, req.user.id);
  } catch (err) {
    if (req.accepts(['html', 'json']) === 'json') return res.status(err.status || 500).json({ error: err.message });
    throw err;
  }
  if (req.accepts(['html', 'json']) === 'json') return res.json(result);
  res.redirect(`${safeNext(req.body.next) === '/' ? '/requests' : safeNext(req.body.next)}#r${Number(req.params.id)}`);
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
  res.render('user', {
    profile, translated, lists, reading, reviews, comments, counts,
    seo: {
      title: `${profile.username}${translated.length ? (translated.every((n) => n.is_original) ? ' — Author' : ' — Translator') : ''} | ${getSettings().site_name}`,
      description: translated.length ? `Novels ${translated.every((n) => n.is_original) ? 'written' : 'translated'} by ${profile.username}: ${translated.map((n) => n.title).slice(0, 5).join(', ')}.` : undefined,
      canonical: `${res.locals.baseUrl}/user/${encodeURIComponent(profile.username)}`,
      noindex: !translated.length, // only translator profiles are useful in search results
    },
  });
});

// Reading history is kept in the browser (works without an account); the page fills itself in.
router.get('/history', (req, res) => res.render('history', { seo: { title: `Reading history | ${getSettings().site_name}`, noindex: true } }));

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
  const base = res.locals.baseUrl;
  if (getSettings().search_indexing === '0') return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /admin', 'Disallow: /api/', 'Disallow: /login', 'Disallow: /register', 'Disallow: /library',
    'Disallow: /history', 'Disallow: /random', 'Disallow: /search', 'Disallow: /*?q=', 'Disallow: /*&q=',
    '', `Sitemap: ${base}/sitemap.xml`, '',
  ].join('\n'));
});

// Sitemaps: an index pointing at one file for pages/novels and as many chapter files as needed (max 40,000 URLs each).
const CHAPTERS_PER_SITEMAP = 40000;
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const urlTag = (loc, lastmod, extra = '') => `<url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${day(lastmod)}</lastmod>` : ''}${extra}</url>`;

router.get('/sitemap.xml', (req, res) => {
  const base = res.locals.baseUrl;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM chapters c WHERE ${VISIBLE}`).get().n;
  const parts = [`${base}/sitemap-novels.xml`];
  for (let i = 1; i <= Math.ceil(count / CHAPTERS_PER_SITEMAP); i++) parts.push(`${base}/sitemap-chapters-${i}.xml`);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${parts.map((loc) => `<sitemap><loc>${xmlEscape(loc)}</loc></sitemap>`).join('\n')}
</sitemapindex>`);
});

router.get('/sitemap-novels.xml', (req, res) => {
  const base = res.locals.baseUrl;
  const novels = db.prepare(`SELECT n.slug, n.title, n.cover,
    COALESCE((SELECT MAX(${RELEASED}) FROM chapters c WHERE c.novel_id = n.id AND ${VISIBLE}), n.updated_at) AS lastmod FROM novels n ORDER BY lastmod DESC`).all();
  const genres = db.prepare('SELECT g.slug FROM genres g WHERE EXISTS (SELECT 1 FROM novel_genres ng WHERE ng.genre_id = g.id)').all();
  const latest = novels.length ? novels[0].lastmod : null;
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urlTag(`${base}/`, latest)}
${urlTag(`${base}/novels`, latest)}
${urlTag(`${base}/about`, null)}
${urlTag(`${base}/contact`, null)}
${genres.map((g) => urlTag(`${base}/novels?genre=${g.slug}`, null)).join('\n')}
${novels.map((n) => urlTag(`${base}/novel/${n.slug}`, n.lastmod,
    n.cover ? `<image:image><image:loc>${xmlEscape(`${base}/uploads/covers/${n.cover}`)}</image:loc></image:image>` : '')).join('\n')}
</urlset>`);
});

router.get('/sitemap-chapters-:n.xml', (req, res, next) => {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1) return next(notFound());
  const base = res.locals.baseUrl;
  const rows = db.prepare(`SELECT n.slug, c.number, ${RELEASED} AS lastmod FROM chapters c JOIN novels n ON n.id = c.novel_id
    WHERE ${VISIBLE} ORDER BY c.id LIMIT ? OFFSET ?`).all(CHAPTERS_PER_SITEMAP, (n - 1) * CHAPTERS_PER_SITEMAP);
  if (!rows.length && n > 1) return next(notFound());
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map((c) => urlTag(`${base}/novel/${c.slug}/c/${formatNumber(c.number)}`, c.lastmod)).join('\n')}
</urlset>`);
});

// ads.txt: tells ad networks which publisher accounts may sell ads on this site (required by AdSense).
router.get('/ads.txt', (req, res) => {
  const m = String(getSettings().adsense_client || '').match(/^ca-pub-(\d{10,20})$/);
  res.type('text/plain').send(m ? `google.com, pub-${m[1]}, DIRECT, f08c47fec0942fa0\n` : '');
});

// ---------- Contact ----------
const CONTACT_TOPICS = {
  general: 'General question or feedback',
  copyright: 'Copyright / takedown request',
  bug: 'Problem with the site',
  ads: 'Advertising or business',
  other: 'Something else',
};

function contactPage(req, res, extra = {}) {
  const s = getSettings();
  // Signed timestamp: forms sent within a few seconds of loading are almost always bots.
  req.session.contactAt = Date.now();
  res.status(extra.error ? 400 : 200).render('contact', {
    topics: CONTACT_TOPICS, error: null, sent: false,
    form: { name: req.user?.username || '', email: '', topic: Object.hasOwn(CONTACT_TOPICS, String(req.query.topic)) ? req.query.topic : 'general', message: '' },
    ...extra,
    seo: {
      title: `Contact ${s.site_name}`,
      description: `Contact ${s.site_name}: questions, feedback, copyright and takedown requests, problems with the site or advertising.`,
      canonical: `${res.locals.baseUrl}/contact`,
      jsonld: { '@context': 'https://schema.org', '@type': 'ContactPage', name: `Contact ${s.site_name}`, url: `${res.locals.baseUrl}/contact` },
    },
  });
}

router.get('/contact', (req, res) => contactPage(req, res, { sent: req.query.sent === '1' }));

router.post('/contact', async (req, res) => {
  const form = {
    name: String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 200),
    topic: Object.hasOwn(CONTACT_TOPICS, String(req.body.topic)) ? req.body.topic : 'other',
    message: String(req.body.message || '').trim().slice(0, 5000),
  };
  const tooFast = !req.session.contactAt || Date.now() - req.session.contactAt < 3000;
  if (req.body.website || tooFast) {
    // Bot: pretend it worked.
    return res.redirect('/contact?sent=1');
  }
  if (!form.name) return contactPage(req, res, { form, error: 'Please enter your name.' });
  if (!mail.isValidEmail(form.email)) return contactPage(req, res, { form, error: 'Please enter a valid email address so we can reply.' });
  if (form.message.length < 10) return contactPage(req, res, { form, error: 'Please write a little more in your message.' });
  const sender = security.keyedHash(`contact|${req.ip}`).slice(0, 24);
  const today = db.prepare('SELECT COUNT(*) AS n FROM contact_messages WHERE sender = ? AND created_at > unixepoch() - 86400').get(sender).n;
  if (today >= 5) return contactPage(req, res, { form, error: 'You’ve sent several messages today. We’ll read them and get back to you. Please try again tomorrow.' });

  db.prepare('INSERT INTO contact_messages (user_id, name, email, topic, message, page, sender) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user?.id ?? null, form.name, form.email, form.topic, form.message, String(req.get('referer') || '').slice(0, 300), sender);

  // Tell the admins by email (if email is set up); replying goes straight to the sender.
  if (mail.isConfigured()) {
    const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL").all();
    const s = getSettings();
    for (const { email } of admins) {
      mail.send({
        to: email, replyTo: form.email,
        subject: `[${s.site_name}] ${CONTACT_TOPICS[form.topic]}: message from ${form.name}`,
        text: `${form.name} <${form.email}> wrote via the contact page:\n\n${form.message}\n\n— Reply to this email to answer them, or see all messages in the admin panel.`,
      }).catch((err) => console.error('Contact email failed:', err.message));
    }
  }
  req.session.contactAt = null;
  res.redirect('/contact?sent=1');
});

router.get('/about', (req, res) => {
  const s = getSettings();
  const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM novels) AS novels, (SELECT COUNT(*) FROM chapters c WHERE ${VISIBLE}) AS chapters`).get();
  res.render('about', {
    totals, genres: q.allGenres.all().filter((g) => g.novel_count),
    seo: {
      title: `About ${s.site_name} — Web Novel Translations`,
      description: `${s.site_name} is a free site for reading English translations of web novels. Learn what we translate, how often we update and how to follow new chapters.`,
      canonical: `${res.locals.baseUrl}/about`,
      jsonld: { '@context': 'https://schema.org', '@type': 'AboutPage', name: `About ${s.site_name}`, url: `${res.locals.baseUrl}/about`, about: { '@id': `${res.locals.baseUrl}/#org` } },
    },
  });
});

// IndexNow key file (proves to search engines that notifications really come from this site).
router.get('/indexnow-key.txt', (req, res) => res.type('text/plain').send(require('../indexnow').key()));

router.get('/privacy', (req, res) => {
  res.render('privacy', { seo: { title: `Privacy policy | ${getSettings().site_name}`, canonical: `${res.locals.baseUrl}/privacy` } });
});

// Lets phones "Add to home screen" with the site's name and icon.
router.get('/manifest.webmanifest', (req, res) => {
  const s = getSettings();
  res.type('application/manifest+json').send(JSON.stringify({
    name: s.site_name, short_name: s.site_name.slice(0, 12), description: s.site_description,
    start_url: '/', display: 'standalone', background_color: '#15171c', theme_color: '#0f1115',
    icons: [
      { src: '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }));
});

// ---------- Accounts ----------
router.get('/login', (req, res) => res.render('login', { mode: 'login', error: null, next: safeNext(req.query.next), username: '', seo: { title: `Log in | ${getSettings().site_name}`, noindex: true } }));
router.get('/register', (req, res) => res.render('login', { mode: 'register', error: null, next: safeNext(req.query.next), username: '', email: '', seo: { title: `Sign up | ${getSettings().site_name}`, noindex: true } }));

router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  try {
    security.checkLock(req, username);
    let uid;
    try {
      uid = login(username, req.body.password);
    } catch (err) {
      security.recordFailure(req, username);
      security.log(req, 'login_failed', { username });
      throw err;
    }
    security.clearFailures(username);
    security.startSession(req, uid);
    security.log(req, 'login', { userId: uid, username });
    res.redirect(safeNext(req.body.next));
  } catch (err) {
    res.status(400).render('login', { mode: 'login', error: err.message, next: safeNext(req.body.next), username: req.body.username || '' });
  }
});

router.post('/register', async (req, res) => {
  let uid;
  try {
    uid = register(req.body.username, req.body.password, req.body.email);
  } catch (err) {
    return res.status(err.status || 400).render('login', {
      mode: 'register', error: err.message, next: safeNext(req.body.next), username: req.body.username || '', email: req.body.email || '',
      seo: { title: `Sign up | ${getSettings().site_name}`, noindex: true },
    });
  }
  security.startSession(req, uid);
  const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(uid);
  if (user.email && mail.isConfigured()) {
    try {
      await mail.sendVerification(user, user.email, res.locals.baseUrl);
      req.flash('ok', `Welcome, ${user.username}! We sent a confirmation link to ${user.email}.`);
    } catch (err) {
      console.error('Verification email failed:', err.message);
      req.flash('ok', `Welcome, ${user.username}! (We couldn’t send the confirmation email right now. You can resend it from your account page.)`);
    }
  } else {
    req.flash('ok', `Welcome, ${user.username}! Your account is ready.`);
  }
  res.redirect(safeNext(req.body.next));
});

// ---------- Email: verification, password reset, account page ----------
router.get('/verify-email', (req, res) => {
  const t = mail.findToken(String(req.query.token || ''), 'verify');
  if (!t) {
    req.flash('error', 'That confirmation link is invalid or has expired. You can send a new one from your account page.');
    return res.redirect(req.user ? '/account' : '/login');
  }
  mail.useToken(String(req.query.token));
  try {
    checkEmail(t.email, t.user_id, false);
    db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(t.email, t.user_id);
    req.flash('ok', `Thanks! ${t.email} is confirmed.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(req.user ? '/account' : '/login');
});

const authSeo = (title) => ({ title: `${title} | ${getSettings().site_name}`, noindex: true });

router.get('/forgot-password', (req, res) => res.render('forgot', { sent: false, emailReady: mail.isConfigured(), seo: authSeo('Forgot password') }));

router.post('/forgot-password', async (req, res) => {
  const who = String(req.body.who || '').trim();
  const user = who && db.prepare('SELECT id, username, email FROM users WHERE (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) AND email IS NOT NULL').get(who, who);
  // Rate-limit per browser session to avoid spamming someone's inbox.
  const recent = (req.session.resets || []).filter((t) => Date.now() - t < 3600_000);
  if (user && mail.isConfigured() && recent.length < 3) {
    req.session.resets = [...recent, Date.now()];
    try {
      await mail.sendPasswordReset(user, res.locals.baseUrl);
    } catch (err) {
      console.error('Password reset email failed:', err.message);
    }
  }
  // Always the same answer, so nobody can find out which emails have accounts.
  res.render('forgot', { sent: true, emailReady: mail.isConfigured(), seo: authSeo('Forgot password') });
});

router.get('/reset-password', (req, res) => {
  const token = String(req.query.token || '');
  res.render('reset', { token, valid: Boolean(mail.findToken(token, 'reset')), error: null, seo: authSeo('Choose a new password') });
});

router.post('/reset-password', (req, res) => {
  const token = String(req.body.token || '');
  const t = mail.findToken(token, 'reset');
  if (!t) return res.status(400).render('reset', { token, valid: false, error: null, seo: authSeo('Choose a new password') });
  const password = String(req.body.password || '');
  const who = db.prepare('SELECT username FROM users WHERE id = ?').get(t.user_id);
  try {
    security.checkPasswordStrength(password, who?.username);
  } catch (err) {
    return res.status(400).render('reset', { token, valid: true, error: err.message, seo: authSeo('Choose a new password') });
  }
  mail.useToken(token);
  db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(hashPassword(password), t.user_id);
  // Anyone who was logged in to this account (maybe the reason for the reset) is logged out.
  security.bumpTokenVersion(t.user_id);
  security.startSession(req, t.user_id);
  security.clearFailures(who?.username);
  security.log(req, 'password_reset', { userId: t.user_id, username: who?.username });
  req.flash('ok', 'Your password has been changed and you’re logged in.');
  res.redirect('/');
});

function accountPage(req, res, extra = {}) {
  const me = db.prepare('SELECT username, email, email_verified FROM users WHERE id = ?').get(req.user.id);
  res.status(extra.error ? 400 : 200).render('account', { me, emailReady: mail.isConfigured(), error: null, ...extra, seo: authSeo('My account') });
}

router.get('/account', requireLogin, (req, res) => accountPage(req, res));

router.post('/account/email', requireLogin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  try {
    if (!email && getSettings().require_email === '1') throw Object.assign(new Error('An email address is required on this site.'), { status: 400 });
    checkEmail(email, req.user.id, false);
  } catch (err) {
    return accountPage(req, res, { error: err.message });
  }
  const current = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id).email;
  if (email !== (current || '')) db.prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?').run(email || null, req.user.id);
  if (email && mail.isConfigured()) {
    try {
      await mail.sendVerification(req.user, email, res.locals.baseUrl);
      req.flash('ok', `Saved. We sent a confirmation link to ${email}.`);
    } catch (err) {
      console.error('Verification email failed:', err.message);
      req.flash('error', 'Saved, but the confirmation email couldn’t be sent right now. Try “Resend” later.');
    }
  } else {
    req.flash('ok', email ? 'Email saved.' : 'Email removed.');
  }
  res.redirect('/account');
});

router.post('/account/password', requireLogin, (req, res) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.current || ''), row.password_hash)) return accountPage(req, res, { error: 'Your current password is wrong.' });
  try {
    security.checkPasswordStrength(req.body.password, req.user.username);
  } catch (err) {
    return accountPage(req, res, { error: err.message });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), req.user.id);
  security.bumpTokenVersion(req.user.id, req); // other devices are logged out; this one stays in
  security.log(req, 'password_changed', { userId: req.user.id, username: req.user.username });
  req.flash('ok', 'Password changed. You’ve been logged out on your other devices.');
  res.redirect('/account');
});

// Reader settings (theme, font, size…) saved on the account. Sent by the reader page as JSON.
router.post('/account/prefs', requireLogin, (req, res) => {
  const reset = req.body.reset === '1' || req.body.reset === true;
  const prefs = savePrefs(req.user.id, reset ? {} : req.body, { replace: reset });
  if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true, prefs });
  req.flash('ok', reset ? 'Reading settings reset to the defaults.' : 'Reading settings saved.');
  res.redirect('/account');
});

// End every session of this account on other phones/computers (e.g. after using a shared computer).
router.post('/account/logout-all', requireLogin, (req, res) => {
  security.bumpTokenVersion(req.user.id, req);
  security.log(req, 'logout_all', { userId: req.user.id, username: req.user.username });
  req.flash('ok', 'Done: you’ve been logged out everywhere else.');
  res.redirect('/account');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

module.exports = { router, safeNext };
