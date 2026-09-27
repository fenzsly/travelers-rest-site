// The admin panel: a self-contained Express app with its own login, layout and assets.
// Mounted at /admin by default, or served on its own port when ADMIN_PORT is set.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, tx } = require('./db');
const { baseApp, errorHandlers, UPLOAD_DIR } = require('./common');
const { verifyCsrf, requireRole, canManageNovel, hashPassword } = require('./auth');
const { q, ADMIN_NOVEL_COLUMNS: NOVEL_COLUMNS, VISIBLE, RELEASED, setNovelGenres, login } = require('./queries');
const system = require('./system');
const { getSettings, saveSettings } = require('./settings');
const { slugify, paginate, STATUS_LABELS } = require('./util');
const parse = require('./parse');

function createAdminApp({ base = '/admin', publicUrl = '', mounted = false } = {}) {
  const app = baseApp(path.join(__dirname, '..', 'views'), { mounted });
  const A = (p = '') => `${base}${p}`; // admin URL builder

  app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'admin'), { maxAge: '1h' }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
  app.use((req, res, next) => {
    res.locals.A = A;
    res.locals.site = (p = '/') => `${publicUrl}${p}`;
    res.locals.STATUS_LABELS = STATUS_LABELS;
    next();
  });

  const fail = (status, message) => Object.assign(new Error(message), { status });

  // ---------- Login (independent from the public site) ----------
  app.get('/login', (req, res) => {
    if (req.user && req.user.role !== 'reader') return res.redirect(A('/'));
    const firstRun = q.userCount.get().n === 0;
    res.render('admin/login', { error: null, firstRun, username: '' });
  });

  app.post('/login', verifyCsrf, (req, res) => {
    const firstRun = q.userCount.get().n === 0;
    try {
      if (firstRun) {
        // First visit: create the owner account right here.
        const { register } = require('./queries');
        req.session.uid = register(req.body.username, req.body.password);
      } else {
        const uid = login(req.body.username, req.body.password);
        const user = db.prepare('SELECT role FROM users WHERE id = ?').get(uid);
        if (user.role === 'reader') throw fail(403, 'This account does not have access to the admin panel.');
        req.session.uid = uid;
      }
      res.redirect(A('/'));
    } catch (err) {
      res.status(err.status || 400).render('admin/login', { error: err.message, firstRun, username: req.body.username || '' });
    }
  });

  app.post('/logout', verifyCsrf, (req, res) => {
    req.session = null;
    res.redirect(A('/login'));
  });

  // Everything below requires staff access.
  app.use((req, res, next) => {
    if (!req.user || req.user.role === 'reader') return res.redirect(A('/login'));
    next();
  });
  const adminOnly = requireRole('admin');

  // Open reader reports for the novels this person manages (shown as a badge in the sidebar).
  function openReports(user) {
    return db.prepare(`SELECT COUNT(*) AS n FROM reports r JOIN chapters c ON c.id = r.chapter_id JOIN novels n ON n.id = c.novel_id
      WHERE r.status = 'open' ${user.role === 'admin' ? '' : 'AND n.owner_id = ?'}`).get(...(user.role === 'admin' ? [] : [user.id])).n;
  }
  app.use((req, res, next) => {
    res.locals.openReports = openReports(req.user);
    next();
  });

  const coverUpload = multer({
    storage: multer.diskStorage({
      destination: path.join(UPLOAD_DIR, 'covers'),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) && /\.(jpe?g|png|webp|gif)$/i.test(file.originalname);
      cb(ok ? null : fail(400, 'Cover must be a JPG, PNG, WEBP or GIF image.'), ok);
    },
  });
  const chapterUpload = multer({
    storage: multer.memoryStorage(),
    preservePath: true,
    limits: { fileSize: 100 * 1024 * 1024, files: 1000 },
  });

  app.use((req, res, next) => (req.is('multipart/form-data') ? next() : verifyCsrf(req, res, next)));

  /** A future unix timestamp for a scheduled release, or null to publish immediately. */
  function readPublishAt(value) {
    const t = Number(value);
    return Number.isFinite(t) && t > Date.now() / 1000 + 30 ? Math.floor(t) : null;
  }

  /** Daily views for the last `days` days (oldest first), zero-filled. */
  function dailyViews(days, novelIds) {
    if (!novelIds.length) return [];
    const rows = db.prepare(`SELECT day, SUM(views) AS views FROM novel_views_daily
      WHERE day >= date('now', ?) AND novel_id IN (${novelIds.map(() => '?').join(',')}) GROUP BY day`).all(`-${days - 1} days`, ...novelIds);
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.views]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push({ day, views: byDay[day] || 0 });
    }
    return out;
  }

  function novelsFor(user) {
    return user.role === 'admin'
      ? db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n ORDER BY n.updated_at DESC`).all()
      : db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE n.owner_id = ? ORDER BY n.updated_at DESC`).all(user.id);
  }

  function loadNovel(req, res, next) {
    const novel = q.novelById.get(Number(req.params.id));
    if (!novel) return next(fail(404, 'Novel not found.'));
    if (!canManageNovel(req.user, novel)) return next(fail(403, 'You can only manage your own novels.'));
    req.novel = novel;
    next();
  }

  // ---------- Dashboard ----------
  app.get('/', (req, res) => {
    const mine = req.user.role === 'admin' ? '' : 'WHERE n.owner_id = ?';
    const args = req.user.role === 'admin' ? [] : [req.user.id];
    const stats = db.prepare(`
      SELECT COUNT(*) AS novels, COALESCE(SUM(n.views), 0) AS views,
        (SELECT COUNT(*) FROM chapters c JOIN novels n2 ON n2.id = c.novel_id ${mine.replace('n.', 'n2.')}) AS chapters,
        (SELECT COALESCE(SUM(word_count), 0) FROM chapters c JOIN novels n2 ON n2.id = c.novel_id ${mine.replace('n.', 'n2.')}) AS words
      FROM novels n ${mine}`).get(...args, ...args, ...args);
    stats.users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    stats.comments = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
    const recent = db.prepare(`
      SELECT c.id, c.number, c.title, ${RELEASED} AS released_at, c.views, n.title AS novel_title, n.slug, n.id AS novel_id
      FROM chapters c JOIN novels n ON n.id = c.novel_id ${mine ? `${mine} AND` : 'WHERE'} ${VISIBLE}
      ORDER BY released_at DESC, c.number DESC LIMIT 10`).all(...args);
    const scheduled = db.prepare(`
      SELECT c.id, c.number, c.title, c.publish_at, n.title AS novel_title, n.id AS novel_id
      FROM chapters c JOIN novels n ON n.id = c.novel_id ${mine ? `${mine} AND` : 'WHERE'} NOT ${VISIBLE}
      ORDER BY c.publish_at ASC LIMIT 8`).all(...args);
    const novels = novelsFor(req.user);
    const chart = dailyViews(30, novels.map((n) => n.id));
    stats.today = chart.at(-1)?.views || 0;
    stats.week = chart.slice(-7).reduce((a, d) => a + d.views, 0);
    const top = [...novels].sort((a, b) => b.views_week - a.views_week).slice(0, 5);
    res.render('admin/dashboard', { stats, novels: novels.slice(0, 8), recent, scheduled, chart, top, update: system.status() });
  });

  // ---------- Novels ----------
  app.get('/novels', (req, res) => {
    const search = String(req.query.q || '').trim().toLowerCase();
    let novels = novelsFor(req.user);
    if (search) novels = novels.filter((n) => `${n.title} ${n.alt_titles} ${n.author}`.toLowerCase().includes(search));
    res.render('admin/novels', { novels, search });
  });

  app.get('/novels/:id/stats', loadNovel, (req, res) => {
    const novel = req.novel;
    const chart = dailyViews(30, [novel.id]);
    const topChapters = db.prepare(`SELECT c.id, c.number, c.title, c.views,
        (SELECT COUNT(*) FROM comments cm WHERE cm.chapter_id = c.id) AS comment_count
      FROM chapters c WHERE c.novel_id = ? ORDER BY c.views DESC LIMIT 15`).all(novel.id);
    const extra = db.prepare(`SELECT
        (SELECT COUNT(*) FROM bookmarks WHERE novel_id = ?) AS readers,
        (SELECT COUNT(*) FROM comments cm JOIN chapters c ON c.id = cm.chapter_id WHERE c.novel_id = ?) AS comments,
        (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE novel_id = ?) AS words,
        (SELECT COUNT(*) + 1 FROM novels n2 WHERE n2.views > ?) AS rank,
        (SELECT COALESCE(SUM(views), 0) FROM novel_views_daily WHERE novel_id = ? AND day = date('now')) AS today`)
      .get(novel.id, novel.id, novel.id, novel.views, novel.id);
    // Rough "drop-off": how many readers reach later chapters compared to chapter 1.
    const firstViews = db.prepare('SELECT views FROM chapters WHERE novel_id = ? ORDER BY number LIMIT 1').get(novel.id)?.views || 0;
    const lastViews = db.prepare('SELECT views FROM chapters WHERE novel_id = ? ORDER BY number DESC LIMIT 1').get(novel.id)?.views || 0;
    res.render('admin/stats', { novel, chart, topChapters, extra, retention: firstViews ? Math.round((lastViews / firstViews) * 100) : null });
  });

  function novelFormData(novel = {}) {
    return {
      novel,
      genres: q.allGenres.all(),
      selected: new Set(novel.id ? q.genresForNovel.all(novel.id).map((g) => g.id) : []),
      users: db.prepare("SELECT id, username, role FROM users WHERE role IN ('admin','translator') ORDER BY username").all(),
      error: null,
    };
  }

  function readNovelForm(body) {
    const title = String(body.title || '').trim();
    if (!title) throw fail(400, 'Title is required.');
    const year = parseInt(body.year, 10);
    return {
      title: title.slice(0, 250),
      slug: slugify(body.slug || title),
      alt_titles: String(body.alt_titles || '').trim().slice(0, 1000),
      author: String(body.author || '').trim().slice(0, 200),
      original_language: String(body.original_language || '').trim().slice(0, 50),
      year: Number.isFinite(year) ? year : null,
      status: STATUS_LABELS[body.status] ? body.status : 'ongoing',
      description: String(body.description || '').trim().slice(0, 20000),
      tags: String(body.tags || '').split(',').map((t) => t.trim()).filter(Boolean).join(', ').slice(0, 1000),
      genres: [].concat(body.genres || []).map(Number).filter(Number.isInteger),
    };
  }

  function uniqueSlug(slug, exceptId = 0) {
    let candidate = slug;
    for (let i = 2; db.prepare('SELECT 1 FROM novels WHERE slug = ? AND id != ?').get(candidate, exceptId); i++) {
      candidate = `${slug}-${i}`;
    }
    return candidate;
  }

  function removeCover(file) {
    if (!file) return;
    fs.rm(path.join(UPLOAD_DIR, 'covers', path.basename(file)), { force: true }, () => {});
  }

  app.get('/novels/new', (req, res) => res.render('admin/novel-form', novelFormData()));

  app.post('/novels/new', coverUpload.single('cover'), verifyCsrf, (req, res) => {
    try {
      const f = readNovelForm(req.body);
      const ownerId = req.user.role === 'admin' && req.body.owner_id ? Number(req.body.owner_id) : req.user.id;
      const id = tx(() => {
        const r = db.prepare(`INSERT INTO novels (slug, title, alt_titles, author, original_language, year, status, description, tags, cover, owner_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uniqueSlug(f.slug), f.title, f.alt_titles, f.author, f.original_language,
          f.year, f.status, f.description, f.tags, req.file ? req.file.filename : null, ownerId);
        setNovelGenres(r.lastInsertRowid, f.genres);
        return Number(r.lastInsertRowid);
      });
      req.flash('ok', `“${f.title}” created. Now upload some chapters!`);
      res.redirect(A(`/novels/${id}/upload`));
    } catch (err) {
      if (req.file) removeCover(req.file.filename);
      if (!err.status) throw err;
      res.status(400).render('admin/novel-form', { ...novelFormData(req.body), error: err.message });
    }
  });

  app.get('/novels/:id/edit', loadNovel, (req, res) => res.render('admin/novel-form', novelFormData(req.novel)));

  app.post('/novels/:id/edit', loadNovel, coverUpload.single('cover'), verifyCsrf, (req, res) => {
    const novel = req.novel;
    try {
      const f = readNovelForm(req.body);
      let cover = novel.cover;
      if (req.file) cover = req.file.filename;
      else if (req.body.remove_cover) cover = null;
      const ownerId = req.user.role === 'admin' && req.body.owner_id ? Number(req.body.owner_id) : novel.owner_id;
      tx(() => {
        db.prepare(`UPDATE novels SET slug = ?, title = ?, alt_titles = ?, author = ?, original_language = ?, year = ?, status = ?,
          description = ?, tags = ?, cover = ?, owner_id = ? WHERE id = ?`).run(uniqueSlug(f.slug, novel.id), f.title, f.alt_titles,
          f.author, f.original_language, f.year, f.status, f.description, f.tags, cover, ownerId, novel.id);
        setNovelGenres(novel.id, f.genres);
      });
      if (cover !== novel.cover) removeCover(novel.cover);
      req.flash('ok', 'Novel saved.');
      res.redirect(A(`/novels/${novel.id}/edit`));
    } catch (err) {
      if (req.file) removeCover(req.file.filename);
      if (!err.status) throw err;
      res.status(400).render('admin/novel-form', { ...novelFormData({ ...novel, ...req.body }), error: err.message });
    }
  });

  app.post('/novels/:id/delete', loadNovel, (req, res) => {
    if (String(req.body.confirm || '').trim() !== req.novel.title) {
      req.flash('error', 'To delete, type the exact novel title into the confirmation box.');
      return res.redirect(A(`/novels/${req.novel.id}/edit`));
    }
    db.prepare('DELETE FROM novels WHERE id = ?').run(req.novel.id);
    removeCover(req.novel.cover);
    req.flash('ok', `Deleted “${req.novel.title}” and all its chapters.`);
    res.redirect(A('/novels'));
  });

  // ---------- Chapters ----------
  app.get('/novels/:id/chapters', loadNovel, (req, res) => {
    const perPage = 200;
    const pager = paginate(req.novel.chapter_count, Number(req.query.page), perPage);
    const chapters = db.prepare(`SELECT c.id, c.number, c.volume, c.title, c.word_count, c.views, c.created_at, c.publish_at,
        (SELECT COUNT(*) FROM reports r WHERE r.chapter_id = c.id AND r.status = 'open') AS open_reports,
        NOT ${VISIBLE} AS scheduled,
        (SELECT COUNT(*) FROM comments cm WHERE cm.chapter_id = c.id) AS comment_count
      FROM chapters c WHERE c.novel_id = ? ORDER BY c.number ASC LIMIT ? OFFSET ?`).all(req.novel.id, perPage, pager.offset);
    res.render('admin/chapters', { novel: req.novel, chapters, pager });
  });

  // Inline title/number edits and bulk actions from the chapter table (JSON).
  app.post('/novels/:id/chapters/bulk', loadNovel, (req, res) => {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Number.isInteger);
    const owned = (id) => db.prepare('SELECT id FROM chapters WHERE id = ? AND novel_id = ?').get(id, req.novel.id);
    const action = req.body.action;
    let message = '';
    if (action === 'delete') {
      const del = db.prepare('DELETE FROM chapters WHERE id = ? AND novel_id = ?');
      const n = tx(() => ids.reduce((acc, id) => acc + Number(del.run(id, req.novel.id).changes), 0));
      message = `Deleted ${n} chapter${n === 1 ? '' : 's'}.`;
    } else if (action === 'shift') {
      const by = Number(req.body.by);
      if (!Number.isFinite(by) || by === 0) throw fail(400, 'Enter a non-zero amount to shift by.');
      tx(() => {
        // Two passes via negative numbers avoid UNIQUE collisions while shifting.
        const upd = db.prepare('UPDATE chapters SET number = -(number + ?) - 1000000 WHERE id = ? AND novel_id = ?');
        for (const id of ids) upd.run(by, id, req.novel.id);
        db.prepare('UPDATE chapters SET number = -(number + 1000000) WHERE novel_id = ? AND number <= -1000000').run(req.novel.id);
      });
      message = `Shifted ${ids.length} chapter numbers by ${by > 0 ? '+' : ''}${by}.`;
    } else if (action === 'renumber') {
      // Renumber all chapters 1..N in current order.
      const start = Number(req.body.start) || 1;
      tx(() => {
        const rows = db.prepare('SELECT id FROM chapters WHERE novel_id = ? ORDER BY number').all(req.novel.id);
        const upd = db.prepare('UPDATE chapters SET number = ? WHERE id = ?');
        rows.forEach((r, i) => upd.run(-(i + 1), r.id));
        rows.forEach((r, i) => upd.run(start + i, r.id));
      });
      message = 'Renumbered all chapters in order.';
    } else if (action === 'set_volume') {
      const vol = req.body.volume === '' ? null : Number(req.body.volume);
      if (vol !== null && (!Number.isInteger(vol) || vol < 0)) throw fail(400, 'Volume must be a whole number (or empty for none).');
      const upd = db.prepare('UPDATE chapters SET volume = ? WHERE id = ? AND novel_id = ?');
      tx(() => ids.forEach((id) => upd.run(vol, id, req.novel.id)));
      message = vol ? `Moved ${ids.length} chapter${ids.length === 1 ? '' : 's'} to volume ${vol}.` : `Removed the volume from ${ids.length} chapter${ids.length === 1 ? '' : 's'}.`;
    } else if (action === 'publish_now') {
      const upd = db.prepare('UPDATE chapters SET publish_at = unixepoch() WHERE id = ? AND novel_id = ? AND publish_at > unixepoch()');
      const n = tx(() => ids.reduce((acc, id) => acc + Number(upd.run(id, req.novel.id).changes), 0));
      message = n ? `Released ${n} chapter${n === 1 ? '' : 's'} now.` : 'None of the selected chapters were scheduled.';
    } else if (action === 'schedule') {
      const start = readPublishAt(req.body.start_at);
      const every = Number(req.body.every_hours);
      if (!start) throw fail(400, 'Pick a start time in the future.');
      if (!Number.isFinite(every) || every < 0) throw fail(400, 'Enter how many hours between releases (0 = all at once).');
      tx(() => {
        const rows = db.prepare(`SELECT id FROM chapters WHERE novel_id = ? AND id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY number`).all(req.novel.id, ...ids);
        const upd = db.prepare('UPDATE chapters SET publish_at = ? WHERE id = ?');
        rows.forEach((r, i) => upd.run(Math.round(start + i * every * 3600), r.id));
      });
      message = `Scheduled ${ids.length} chapter${ids.length === 1 ? '' : 's'}.`;
    } else if (action === 'update') {
      const { id, title, number } = req.body;
      if (!owned(Number(id))) throw fail(404, 'Chapter not found.');
      if (title !== undefined) db.prepare('UPDATE chapters SET title = ? WHERE id = ?').run(String(title).trim().slice(0, 250), Number(id));
      if (number !== undefined) {
        const n = Number(number);
        if (!Number.isFinite(n) || n < 0) throw fail(400, 'Chapter number must be a positive number.');
        const clash = db.prepare('SELECT id FROM chapters WHERE novel_id = ? AND number = ? AND id != ?').get(req.novel.id, n, Number(id));
        if (clash) throw fail(400, `Chapter ${n} already exists.`);
        db.prepare('UPDATE chapters SET number = ? WHERE id = ?').run(n, Number(id));
      }
      return res.json({ ok: true });
    } else {
      throw fail(400, 'Unknown action.');
    }
    if (req.is('json')) return res.json({ ok: true, message });
    req.flash('ok', message);
    res.redirect(A(`/novels/${req.novel.id}/chapters`));
  });

  function chapterForm(novel, chapter, error = null) {
    const next = q.maxChapterNumber.get(novel.id).m;
    const lastVol = db.prepare('SELECT volume FROM chapters WHERE novel_id = ? ORDER BY number DESC LIMIT 1').get(novel.id)?.volume ?? '';
    return { novel, chapter: chapter || { number: Math.floor(next || 0) + 1, volume: lastVol, title: '', content: '' }, error };
  }

  function readChapterForm(body) {
    const number = Number(body.number);
    if (!Number.isFinite(number) || number < 0) throw fail(400, 'Chapter number must be a positive number.');
    const raw = String(body.content || '');
    let html;
    if (body.format === 'text') html = parse.textToHtml(raw);
    else if (body.format === 'markdown') html = require('marked').marked.parse(raw);
    else html = raw;
    const content = parse.sanitize(html);
    if (!content) throw fail(400, 'Chapter content is empty.');
    const volume = body.volume === undefined || body.volume === '' ? null : Number(body.volume);
    if (volume !== null && (!Number.isInteger(volume) || volume < 0)) throw fail(400, 'Volume must be a whole number (or empty).');
    return { number, volume, title: String(body.title || '').trim().slice(0, 250), content, wordCount: parse.wordCount(content), publishAt: readPublishAt(body.publish_at) };
  }

  app.get('/novels/:id/chapters/new', loadNovel, (req, res) => res.render('admin/chapter-form', chapterForm(req.novel)));

  app.post('/novels/:id/chapters/new', loadNovel, (req, res) => {
    try {
      const f = readChapterForm(req.body);
      if (q.chapterByNumber.get(req.novel.id, f.number)) throw fail(400, `Chapter ${f.number} already exists.`);
      db.prepare('INSERT INTO chapters (novel_id, number, volume, title, content, word_count, publish_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.novel.id, f.number, f.volume, f.title, f.content, f.wordCount, f.publishAt);
      q.touchNovel.run(req.novel.id);
      req.flash('ok', f.publishAt ? `Chapter ${f.number} scheduled.` : `Chapter ${f.number} published.`);
      res.redirect(req.body.and_new ? A(`/novels/${req.novel.id}/chapters/new`) : A(`/novels/${req.novel.id}/chapters`));
    } catch (err) {
      if (!err.status) throw err;
      res.status(400).render('admin/chapter-form', chapterForm(req.novel, req.body, err.message));
    }
  });

  app.get('/novels/:id/chapters/:cid/edit', loadNovel, (req, res, next) => {
    const chapter = db.prepare('SELECT * FROM chapters WHERE id = ? AND novel_id = ?').get(Number(req.params.cid), req.novel.id);
    if (!chapter) return next(fail(404, 'Chapter not found.'));
    res.render('admin/chapter-form', chapterForm(req.novel, chapter));
  });

  app.post('/novels/:id/chapters/:cid/edit', loadNovel, (req, res, next) => {
    const chapter = db.prepare('SELECT * FROM chapters WHERE id = ? AND novel_id = ?').get(Number(req.params.cid), req.novel.id);
    if (!chapter) return next(fail(404, 'Chapter not found.'));
    try {
      const f = readChapterForm(req.body);
      const clash = db.prepare('SELECT id FROM chapters WHERE novel_id = ? AND number = ? AND id != ?').get(req.novel.id, f.number, chapter.id);
      if (clash) throw fail(400, `Chapter ${f.number} already exists.`);
      // A future time keeps/sets the schedule; clearing it on a scheduled chapter releases it now.
      const now = Math.floor(Date.now() / 1000);
      const publishAt = f.publishAt ?? (chapter.publish_at > now ? now : chapter.publish_at);
      db.prepare('UPDATE chapters SET number = ?, volume = ?, title = ?, content = ?, word_count = ?, publish_at = ? WHERE id = ?')
        .run(f.number, f.volume, f.title, f.content, f.wordCount, publishAt, chapter.id);
      req.flash('ok', 'Chapter saved.');
      res.redirect(A(`/novels/${req.novel.id}/chapters/${chapter.id}/edit`));
    } catch (err) {
      if (!err.status) throw err;
      res.status(400).render('admin/chapter-form', chapterForm(req.novel, { ...chapter, ...req.body }, err.message));
    }
  });

  // ---------- Batch upload ----------
  app.get('/upload', (req, res) => {
    const novels = novelsFor(req.user);
    if (novels.length === 1) return res.redirect(A(`/novels/${novels[0].id}/upload`));
    res.render('admin/upload-pick', { novels });
  });

  app.get('/novels/:id/upload', loadNovel, (req, res) => {
    res.render('admin/upload', { novel: req.novel, novels: novelsFor(req.user) });
  });

  // Step 1: parse files / pasted text into a preview (nothing is saved yet).
  app.post('/novels/:id/upload/parse', loadNovel, chapterUpload.array('files'), verifyCsrf, async (req, res) => {
    const mode = req.body.mode;
    const files = req.files || [];
    let chapters = [];
    let errors = [];
    try {
      if (mode === 'paste') {
        chapters = parse.splitTextIntoChapters(String(req.body.text || ''), { pattern: req.body.pattern });
      } else if (mode === 'split') {
        for (const file of files) chapters.push(...(await parse.parseSingleDocument(file, { pattern: req.body.pattern })));
      } else {
        // Natural sort so "ch2.txt" comes before "ch10.txt".
        files.sort((a, b) => a.originalname.localeCompare(b.originalname, undefined, { numeric: true }));
        ({ chapters, errors } = await parse.parseFilesAsChapters(files));
        chapters.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const max = q.maxChapterNumber.get(req.novel.id).m || 0;
    parse.assignMissingNumbers(chapters, max);
    const existing = q.chapterNumbers.all(req.novel.id).map((r) => r.number);
    res.json({ chapters, errors, existing });
  });

  // Step 2: publish the (possibly edited) preview.
  app.post('/novels/:id/upload/commit', loadNovel, (req, res) => {
    const list = Array.isArray(req.body.chapters) ? req.body.chapters : [];
    const overwrite = req.body.onConflict === 'overwrite';
    if (!list.length) throw fail(400, 'Nothing to publish.');
    if (list.length > 5000) throw fail(400, 'Too many chapters in one batch (max 5000).');
    const insert = db.prepare('INSERT INTO chapters (novel_id, number, volume, title, content, word_count, publish_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const update = db.prepare('UPDATE chapters SET volume = ?, title = ?, content = ?, word_count = ?, publish_at = COALESCE(?, publish_at) WHERE id = ?');
    const result = { created: 0, updated: 0, skipped: [], invalid: [], scheduled: 0 };
    const seen = new Set();
    tx(() => {
      for (const item of list) {
        const number = Number(item.number);
        const content = parse.sanitize(String(item.content || ''));
        if (!Number.isFinite(number) || number < 0 || !content || seen.has(number)) {
          result.invalid.push(item.number);
          continue;
        }
        seen.add(number);
        const title = String(item.title || '').trim().slice(0, 250);
        const words = parse.wordCount(content);
        const publishAt = readPublishAt(item.publish_at);
        const volume = Number.isInteger(Number(item.volume)) && Number(item.volume) > 0 && item.volume !== '' && item.volume !== null ? Number(item.volume) : null;
        if (publishAt) result.scheduled++;
        const existing = q.chapterByNumber.get(req.novel.id, number);
        if (existing && !overwrite) result.skipped.push(number);
        else if (existing) { update.run(volume, title, content, words, publishAt, existing.id); result.updated++; }
        else { insert.run(req.novel.id, number, volume, title, content, words, publishAt); result.created++; }
      }
      if (result.created || result.updated) q.touchNovel.run(req.novel.id);
    });
    res.json(result);
  });

  // ---------- Reader reports ----------
  app.get('/reports', (req, res) => {
    const show = req.query.show === 'resolved' ? 'resolved' : 'open';
    const mine = req.user.role === 'admin' ? '' : 'AND n.owner_id = ?';
    const reports = db.prepare(`SELECT r.*, u.username, c.id AS chapter_id, c.number, c.volume, c.title, n.id AS novel_id, n.title AS novel_title, n.slug
      FROM reports r JOIN chapters c ON c.id = r.chapter_id JOIN novels n ON n.id = c.novel_id LEFT JOIN users u ON u.id = r.user_id
      WHERE r.status = ? ${mine} ORDER BY r.created_at DESC LIMIT 300`).all(show, ...(mine ? [req.user.id] : []));
    res.render('admin/reports', { reports, show });
  });

  app.post('/reports/:rid', (req, res) => {
    const r = db.prepare('SELECT r.id, n.owner_id FROM reports r JOIN chapters c ON c.id = r.chapter_id JOIN novels n ON n.id = c.novel_id WHERE r.id = ?').get(Number(req.params.rid));
    if (!r) throw fail(404, 'Report not found.');
    if (req.user.role !== 'admin' && r.owner_id !== req.user.id) throw fail(403, 'You can only handle reports for your own novels.');
    if (req.body.action === 'delete') db.prepare('DELETE FROM reports WHERE id = ?').run(r.id);
    else db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(req.body.action === 'reopen' ? 'open' : 'resolved', r.id);
    res.redirect(req.get('referer')?.includes('/reports') ? req.get('referer') : A('/reports'));
  });

  // ---------- Users (admin) ----------
  app.get('/users', adminOnly, (req, res) => {
    const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM novels n WHERE n.owner_id = u.id) AS novel_count,
      (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comment_count FROM users u ORDER BY u.created_at DESC`).all();
    res.render('admin/users', { users, newPassword: null });
  });

  app.post('/users/new', adminOnly, (req, res) => {
    const username = String(req.body.username || '').trim();
    const role = ['reader', 'translator', 'admin'].includes(req.body.role) ? req.body.role : 'translator';
    if (role === 'admin' && !req.user.is_owner) throw fail(403, 'Only the site owner can create admin accounts.');
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) throw fail(400, 'Username must be 3–24 characters: letters, numbers, _ . -');
    if (q.userByName.get(username)) throw fail(400, 'That username is taken.');
    const password = String(req.body.password || '') || crypto.randomBytes(6).toString('base64url');
    if (password.length < 8) throw fail(400, 'Password must be at least 8 characters (or leave empty to generate one).');
    q.insertUser.run(username, hashPassword(password), role);
    req.flash('ok', `Created ${role} “${username}”. Password: ${password}`);
    res.redirect(A('/users'));
  });

  app.post('/users/:uid', adminOnly, (req, res) => {
    const uid = Number(req.params.uid);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!target) throw fail(404, 'User not found.');
    const action = req.body.action;
    if (uid === req.user.id && action !== 'reset') throw fail(400, 'You cannot change or delete your own account here.');
    // The owner account can only be managed by the owner.
    if (target.is_owner && uid !== req.user.id) throw fail(403, 'The site owner’s account is protected and cannot be changed by anyone else.');
    // Only the owner decides who is an admin.
    if (!req.user.is_owner && (target.role === 'admin' || req.body.role === 'admin')) {
      throw fail(403, 'Only the site owner can change or remove admin accounts.');
    }
    if (action === 'role' && ['reader', 'translator', 'admin'].includes(req.body.role)) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, uid);
      req.flash('ok', `${target.username} is now ${req.body.role === 'admin' ? 'an admin' : `a ${req.body.role}`}.`);
    } else if (action === 'reset') {
      const password = crypto.randomBytes(6).toString('base64url');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), uid);
      req.flash('ok', `New password for ${target.username}: ${password}`);
    } else if (action === 'delete') {
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
      req.flash('ok', `Deleted ${target.username}. Their novels were kept.`);
    }
    res.redirect(A('/users'));
  });

  // ---------- Own account ----------
  app.get('/account', (req, res) => res.render('admin/account', { error: null }));
  app.post('/account', (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const { verifyPassword } = require('./auth');
    let error = null;
    if (!verifyPassword(String(req.body.current || ''), row.password_hash)) error = 'Current password is wrong.';
    else if (String(req.body.password || '').length < 8) error = 'New password must be at least 8 characters.';
    if (error) return res.status(400).render('admin/account', { error });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), req.user.id);
    req.flash('ok', 'Password changed.');
    res.redirect(A('/account'));
  });

  // ---------- Comments (admin) ----------
  app.get('/comments', adminOnly, (req, res) => {
    const comments = db.prepare(`SELECT cm.*, u.username, c.number, n.title AS novel_title, n.slug
      FROM comments cm JOIN users u ON u.id = cm.user_id JOIN chapters c ON c.id = cm.chapter_id JOIN novels n ON n.id = c.novel_id
      ORDER BY cm.created_at DESC LIMIT 200`).all();
    const reviews = db.prepare(`SELECT rv.*, u.username, n.title AS novel_title, n.slug FROM reviews rv
      JOIN users u ON u.id = rv.user_id JOIN novels n ON n.id = rv.novel_id ORDER BY rv.updated_at DESC LIMIT 100`).all();
    res.render('admin/comments', { comments, reviews });
  });

  app.post('/reviews/:rid/delete', adminOnly, (req, res) => {
    db.prepare('DELETE FROM reviews WHERE id = ?').run(Number(req.params.rid));
    req.flash('ok', 'Review deleted.');
    res.redirect(A('/comments'));
  });

  app.post('/comments/:cid/delete', adminOnly, (req, res) => {
    db.prepare('DELETE FROM comments WHERE id = ?').run(Number(req.params.cid));
    req.flash('ok', 'Comment deleted.');
    res.redirect(A('/comments'));
  });

  // ---------- Settings (admin) ----------
  app.get('/settings', adminOnly, (req, res) => res.render('admin/settings'));
  app.post('/settings', adminOnly, (req, res) => {
    saveSettings({
      site_name: String(req.body.site_name || '').trim().slice(0, 80) || 'Novel Site',
      site_tagline: String(req.body.site_tagline || '').trim().slice(0, 200),
      announcement: String(req.body.announcement || '').trim().slice(0, 1000),
      footer_text: String(req.body.footer_text || '').trim().slice(0, 1000),
      allow_registration: req.body.allow_registration ? '1' : '0',
      comments_enabled: req.body.comments_enabled ? '1' : '0',
      default_role: req.body.default_role === 'translator' ? 'translator' : 'reader',
    });
    req.flash('ok', 'Settings saved.');
    res.redirect(A('/settings'));
  });

  // ---------- System: updates & backups (admin) ----------
  app.get('/system', adminOnly, async (req, res) => {
    const info = await system.info(req.query.check === '1');
    res.render('admin/system', { info, update: system.status(), last: system.lastUpdate() });
  });

  app.post('/system/update', adminOnly, (req, res) => {
    system.startUpdate();
    req.flash('ok', 'Update started. The site restarts by itself when it finishes (usually under a minute).');
    res.redirect(A('/system'));
  });

  app.post('/system/undo', adminOnly, (req, res) => {
    if (system.undoLastUpdate()) req.flash('ok', 'Going back to the previous version. The site restarts by itself in under a minute.');
    else req.flash('error', 'There is no update to undo.');
    res.redirect(A('/system'));
  });

  app.get('/system/status.json', adminOnly, (req, res) => res.json(system.status()));

  app.get('/system/backup', adminOnly, (req, res, next) => {
    const file = system.backupDatabase();
    res.download(file, `site-backup-${new Date().toISOString().slice(0, 10)}.db`, (err) => {
      fs.rm(file, { force: true }, () => {});
      if (err && !res.headersSent) next(err);
    });
  });

  errorHandlers(app, 'admin/error');
  return app;
}

module.exports = { createAdminApp };
