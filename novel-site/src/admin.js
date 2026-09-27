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
const { q, NOVEL_COLUMNS, setNovelGenres, login } = require('./queries');
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
    limits: { fileSize: 20 * 1024 * 1024, files: 1000 },
  });

  app.use((req, res, next) => (req.is('multipart/form-data') ? next() : verifyCsrf(req, res, next)));

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
      SELECT c.id, c.number, c.title, c.created_at, c.views, n.title AS novel_title, n.slug, n.id AS novel_id
      FROM chapters c JOIN novels n ON n.id = c.novel_id ${mine}
      ORDER BY c.created_at DESC, c.number DESC LIMIT 12`).all(...args);
    res.render('admin/dashboard', { stats, novels: novelsFor(req.user).slice(0, 8), recent });
  });

  // ---------- Novels ----------
  app.get('/novels', (req, res) => {
    const search = String(req.query.q || '').trim().toLowerCase();
    let novels = novelsFor(req.user);
    if (search) novels = novels.filter((n) => `${n.title} ${n.alt_titles} ${n.author}`.toLowerCase().includes(search));
    res.render('admin/novels', { novels, search });
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
    const chapters = db.prepare(`SELECT c.id, c.number, c.title, c.word_count, c.views, c.created_at,
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
    return { novel, chapter: chapter || { number: Math.floor(next || 0) + 1, title: '', content: '' }, error };
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
    return { number, title: String(body.title || '').trim().slice(0, 250), content, wordCount: parse.wordCount(content) };
  }

  app.get('/novels/:id/chapters/new', loadNovel, (req, res) => res.render('admin/chapter-form', chapterForm(req.novel)));

  app.post('/novels/:id/chapters/new', loadNovel, (req, res) => {
    try {
      const f = readChapterForm(req.body);
      if (q.chapterByNumber.get(req.novel.id, f.number)) throw fail(400, `Chapter ${f.number} already exists.`);
      db.prepare('INSERT INTO chapters (novel_id, number, title, content, word_count) VALUES (?, ?, ?, ?, ?)')
        .run(req.novel.id, f.number, f.title, f.content, f.wordCount);
      q.touchNovel.run(req.novel.id);
      req.flash('ok', `Chapter ${f.number} published.`);
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
      db.prepare('UPDATE chapters SET number = ?, title = ?, content = ?, word_count = ? WHERE id = ?')
        .run(f.number, f.title, f.content, f.wordCount, chapter.id);
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
    const insert = db.prepare('INSERT INTO chapters (novel_id, number, title, content, word_count) VALUES (?, ?, ?, ?, ?)');
    const update = db.prepare('UPDATE chapters SET title = ?, content = ?, word_count = ? WHERE id = ?');
    const result = { created: 0, updated: 0, skipped: [], invalid: [] };
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
        const existing = q.chapterByNumber.get(req.novel.id, number);
        if (existing && !overwrite) result.skipped.push(number);
        else if (existing) { update.run(title, content, words, existing.id); result.updated++; }
        else { insert.run(req.novel.id, number, title, content, words); result.created++; }
      }
      if (result.created || result.updated) q.touchNovel.run(req.novel.id);
    });
    res.json(result);
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
    res.render('admin/comments', { comments });
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

  errorHandlers(app, 'admin/error');
  return app;
}

module.exports = { createAdminApp };
