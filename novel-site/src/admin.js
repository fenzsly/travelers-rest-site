// The admin panel: a self-contained Express app with its own login, layout and assets.
// Mounted at /admin by default, or served on its own port when ADMIN_PORT is set.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, tx } = require('./db');
const { baseApp, errorHandlers, assetUrl, UPLOAD_DIR } = require('./common');
const { verifyCsrf, requireRole, canManageNovel, hashPassword } = require('./auth');
const { q, ADMIN_NOVEL_COLUMNS: NOVEL_COLUMNS, VISIBLE, RELEASED, setNovelGenres, cleanGenreName, createGenre, login } = require('./queries');
const system = require('./system');
const security = require('./security');
const content = require('./content');
const { getSettings, saveSettings } = require('./settings');
const { slugify, paginate, STATUS_LABELS } = require('./util');
const parse = require('./parse');

function createAdminApp({ base = '/admin', publicUrl = '', mounted = false } = {}) {
  const app = baseApp(path.join(__dirname, '..', 'views'), { mounted, adminOnly: !mounted });
  const A = (p = '') => `${base}${p}`; // admin URL builder

  // The admin panel is never cached, framed, or allowed to load scripts from other sites.
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
    });
    next();
  });
  app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'admin'), { maxAge: '1h' }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
  app.use((req, res, next) => {
    res.locals.A = A;
    // Versioned admin CSS/JS links, so browsers load the new files after an update.
    res.locals.AV = (p) => A(assetUrl(p, path.join(__dirname, '..', 'public', 'admin'), '/assets'));
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

  app.post('/login', verifyCsrf, async (req, res) => {
    const firstRun = q.userCount.get().n === 0;
    const username = String(req.body.username || '').trim();
    try {
      if (firstRun) {
        // First visit: create the owner account right here.
        const { register } = require('./queries');
        const uid = register(username, req.body.password);
        security.startSession(req, uid);
        security.log(req, 'login', { userId: uid, username, detail: 'owner account created' });
      } else {
        security.checkLock(req, username);
        let uid;
        try {
          uid = login(username, req.body.password);
        } catch (err) {
          security.recordFailure(req, username);
          security.log(req, 'login_failed', { username, detail: 'admin panel' });
          throw err;
        }
        const user = db.prepare('SELECT role FROM users WHERE id = ?').get(uid);
        if (user.role === 'reader') throw fail(403, 'This account does not have access to the admin panel.');
        security.clearFailures(username);
        security.startSession(req, uid);
        security.log(req, 'login', { userId: uid, username, detail: 'admin panel' });
      }
      res.redirect(A('/'));
    } catch (err) {
      res.status(err.status || 400).render('admin/login', { error: err.message, firstRun, username: req.body.username || '' });
    }
  });

  // ---------- Two-factor step ----------
  const MFA_MAX_AGE = 7 * 86400 * 1000; // ask for a fresh code at least once a week

  app.get('/2fa', (req, res) => {
    if (!req.user || req.user.role === 'reader') return res.redirect(A('/login'));
    if (!req.user.totp_enabled) return res.redirect(A('/'));
    res.render('admin/2fa', { error: null });
  });

  app.post('/2fa', verifyCsrf, async (req, res) => {
    if (!req.user || req.user.role === 'reader') return res.redirect(A('/login'));
    try {
      security.checkLock(req, `2fa:${req.user.username}`);
    } catch (err) {
      return res.status(429).render('admin/2fa', { error: err.message });
    }
    const kind = security.verifySecondFactor(req.user.id, req.body.code);
    if (!kind) {
      security.recordFailure(req, `2fa:${req.user.username}`);
      security.log(req, 'twofa_failed', { userId: req.user.id, username: req.user.username });
      return res.status(400).render('admin/2fa', { error: 'That code didn’t work. Check the time on your phone is correct, and use the newest code.' });
    }
    security.clearFailures(`2fa:${req.user.username}`);
    req.session.mfa = 1;
    req.session.mfaAt = Date.now();
    security.log(req, kind === 'backup' ? 'twofa_backup' : 'twofa_ok', { userId: req.user.id, username: req.user.username });
    await newDeviceAlert(req);
    if (kind === 'backup') {
      const left = JSON.parse(db.prepare('SELECT totp_backup FROM users WHERE id = ?').get(req.user.id).totp_backup).length;
      req.flash(left <= 3 ? 'error' : 'ok', `Backup code used. ${left} left${left <= 3 ? ': make new ones under 🔐 Security' : ''}.`);
    }
    res.redirect(A('/'));
  });

  /** Email the account owner the first time the admin panel is opened from a new IP address. */
  async function newDeviceAlert(req) {
    const seen = db.prepare("SELECT 1 FROM security_log WHERE user_id = ? AND event = 'admin_login' AND ip = ? LIMIT 1").get(req.user.id, req.ip);
    const first = !db.prepare("SELECT 1 FROM security_log WHERE user_id = ? AND event = 'admin_login' LIMIT 1").get(req.user.id);
    security.log(req, 'admin_login', { userId: req.user.id, username: req.user.username });
    if (seen || first) return;
    const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    const mail = require('./mail');
    if (!me?.email || !mail.isConfigured()) return;
    try {
      await mail.send({
        to: me.email,
        subject: `New sign-in to the ${getSettings().site_name} admin panel`,
        text: `Hi ${req.user.username},\n\nYour account was just used to open the admin panel from a new place:\n\nIP address: ${req.ip}\nBrowser: ${req.get('user-agent') || 'unknown'}\nTime: ${new Date().toUTCString()}\n\nIf this was you, you can ignore this email.\nIf it wasn't, change your password right away and press “Log out all devices” in the admin panel under 🔐 Security.`,
      });
      security.log(req, 'new_device_alert', { userId: req.user.id, username: req.user.username });
    } catch (err) {
      console.error('New sign-in email failed:', err.message);
    }
  }

  app.post('/logout', verifyCsrf, (req, res) => {
    req.session = null;
    res.redirect(A('/login'));
  });

  // Everything below requires staff access.
  app.use(async (req, res, next) => {
    if (!req.user || req.user.role === 'reader') return res.redirect(A('/login'));
    // Two-factor: a fresh code is needed for the admin panel (at least once a week).
    if (req.user.totp_enabled) {
      if (!req.session.mfa || !(Date.now() - (req.session.mfaAt || 0) < MFA_MAX_AGE)) return res.redirect(A('/2fa'));
    } else {
      // Without two-factor, still record (and alert on) admin sign-ins from new places, once per session.
      if (!req.session.seenAdmin) {
        req.session.seenAdmin = 1;
        await newDeviceAlert(req);
      }
      // The owner can require two-factor login for all staff: set it up before anything else.
      if (getSettings().require_2fa === '1' && !/^\/(security|logout)(\/|$)/.test(req.path)) {
        req.flash('error', 'Two-factor login is required for staff on this site. Please set it up to continue.');
        return res.redirect(A('/security'));
      }
    }
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
    res.locals.openRequests = db.prepare("SELECT COUNT(*) AS n FROM novel_requests WHERE status = 'open'").get().n;
    res.locals.waitingUpdates = require('./update-requests').waitingNovels(req.user.role === 'admin' ? null : req.user.id);
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
    // Daily unique visitors (whole site, admins) and unique readers (people who opened a chapter of these novels).
    const visitors = require('./visitors');
    const readerChart = visitors.readersByDay(30, novels.map((n) => n.id));
    const visitorChart = req.user.role === 'admin' ? visitors.siteVisitorsByDay(30) : null;
    const people = {
      visitorsToday: visitorChart ? visitorChart.at(-1).views : null,
      visitorsYesterday: visitorChart ? visitorChart.at(-2).views : null,
      visitorsAvg: visitorChart ? Math.round(visitorChart.slice(-7).reduce((a, d) => a + d.views, 0) / 7) : null,
      readersToday: readerChart.at(-1).views,
      readersYesterday: readerChart.at(-2).views,
    };
    const wantUpdates = require('./update-requests').leaderboard({ ownerId: req.user.role === 'admin' ? null : req.user.id, limit: 5 }).filter((n) => n.waiting);
    res.render('admin/dashboard', { stats, novels: novels.slice(0, 8), recent, scheduled, chart, top, wantUpdates, people, visitorChart, readerChart, update: system.status() });
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
    const readerChart = require('./visitors').readersByDay(30, [novel.id]);
    extra.readersToday = readerChart.at(-1).views;
    extra.readersAvg = Math.round(readerChart.slice(-7).reduce((a, d) => a + d.views, 0) / 7);
    res.render('admin/stats', { novel, chart, readerChart, topChapters, extra, retention: firstViews ? Math.round((lastViews / firstViews) * 100) : null });
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
      seo_title: String(body.seo_title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      seo_description: String(body.seo_description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      genres: [].concat(body.genres || []).map(Number).filter(Number.isInteger),
      newGenres: String(body.new_genres || '').split(',').map((g) => g.trim()).filter(Boolean).slice(0, 10),
    };
  }

  /** Genre ids from the form, plus any new genres an admin typed in (created site-wide). */
  function withNewGenres(f, user) {
    if (!f.newGenres.length) return f.genres;
    if (user.role !== 'admin') throw fail(403, 'Only admins can create new genres.');
    return [...f.genres, ...f.newGenres.map((name) => createGenre(name).id)];
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
        db.prepare('UPDATE novels SET seo_title = ?, seo_description = ? WHERE id = ?').run(f.seo_title, f.seo_description, r.lastInsertRowid);
        setNovelGenres(r.lastInsertRowid, withNewGenres(f, req.user));
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
          description = ?, tags = ?, cover = ?, owner_id = ?, seo_title = ?, seo_description = ? WHERE id = ?`).run(uniqueSlug(f.slug, novel.id), f.title, f.alt_titles,
          f.author, f.original_language, f.year, f.status, f.description, f.tags, cover, ownerId, f.seo_title, f.seo_description, novel.id);
        setNovelGenres(novel.id, withNewGenres(f, req.user));
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

  // ---------- Genres (admin) ----------
  app.get('/genres', adminOnly, (req, res) => {
    res.render('admin/genres', { genres: q.allGenres.all() });
  });

  app.post('/genres/new', adminOnly, (req, res) => {
    const names = String(req.body.name || '').split(',').map((n) => n.trim()).filter(Boolean);
    if (!names.length) throw fail(400, 'Type a genre name first.');
    const results = tx(() => names.slice(0, 20).map((n) => createGenre(n)));
    const added = results.filter((r) => r.created).map((r) => r.name);
    const existed = results.filter((r) => !r.created).map((r) => r.name);
    req.flash(added.length ? 'ok' : 'error', [
      added.length ? `Added ${added.map((n) => `“${n}”`).join(', ')} to the site’s genres.` : '',
      existed.length ? `${existed.map((n) => `“${n}”`).join(', ')} already exist${existed.length === 1 ? 's' : ''}.` : '',
    ].filter(Boolean).join(' '));
    res.redirect(A('/genres'));
  });

  app.post('/genres/:gid', adminOnly, (req, res) => {
    const genre = db.prepare('SELECT * FROM genres WHERE id = ?').get(Number(req.params.gid));
    if (!genre) throw fail(404, 'Genre not found.');
    if (req.body.action === 'delete') {
      db.prepare('DELETE FROM genres WHERE id = ?').run(genre.id);
      req.flash('ok', `Deleted the genre “${genre.name}”. Novels that had it keep their other genres.`);
    } else {
      const name = cleanGenreName(req.body.name);
      const slug = slugify(name);
      const clash = db.prepare('SELECT 1 FROM genres WHERE (slug = ? OR name = ? COLLATE NOCASE) AND id != ?').get(slug, name, genre.id);
      if (clash) throw fail(400, `A genre called “${name}” already exists.`);
      db.prepare('UPDATE genres SET name = ?, slug = ? WHERE id = ?').run(name, slug, genre.id);
      req.flash('ok', `Renamed “${genre.name}” to “${name}”.`);
    }
    res.redirect(A('/genres'));
  });

  // ---------- Test novel ----------
  // Adds an original sample novel (2 volumes, 8 chapters, last one scheduled for tomorrow) to try the site with.
  app.post('/demo-novel', adminOnly, (req, res) => {
    const demo = require('./demo-novel');
    const cover = `demo-${Date.now()}.png`;
    fs.copyFileSync(path.join(__dirname, '..', 'public', 'admin', 'demo-cover.png'), path.join(UPLOAD_DIR, 'covers', cover));
    const id = tx(() => {
      const r = db.prepare(`INSERT INTO novels (slug, title, alt_titles, author, original_language, year, status, description, tags, cover, owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uniqueSlug(slugify(demo.title)), demo.title, demo.alt_titles, demo.author,
        demo.original_language, demo.year, demo.status, demo.description, demo.tags, cover, req.user.id);
      const novelId = Number(r.lastInsertRowid);
      const genreIds = demo.genres.map((g) => db.prepare('SELECT id FROM genres WHERE name = ?').get(g)?.id).filter(Boolean);
      setNovelGenres(novelId, genreIds);
      const ins = db.prepare('INSERT INTO chapters (novel_id, number, volume, title, content, word_count, publish_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const last = demo.chapters.length - 1;
      demo.chapters.forEach((c, i) => {
        const html = parse.sanitize(parse.textToHtml(c.text));
        // The final chapter is scheduled for tomorrow so the "coming soon" features can be seen.
        ins.run(novelId, c.number, c.volume, c.title, html, parse.wordCount(html), i === last ? Math.floor(Date.now() / 1000) + 86400 : null);
      });
      return novelId;
    });
    req.flash('ok', `Added the test novel “${demo.title}”: 8 chapters in 2 volumes, with chapter 8 scheduled for tomorrow. Delete it any time from its Details tab.`);
    res.redirect(A(`/novels/${id}/chapters`));
  });

  // ---------- Reader reports ----------
  app.get('/fixes', (req, res) => res.redirect(A('/reports')));
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

  // ---------- Update requests ("more chapters please") ----------
  app.get('/update-requests', (req, res) => {
    const rows = require('./update-requests').leaderboard({ ownerId: req.user.role === 'admin' ? null : req.user.id });
    res.render('admin/update-requests', { rows });
  });

  app.post('/update-requests/:nid/clear', (req, res) => {
    const novel = db.prepare('SELECT id, title, owner_id FROM novels WHERE id = ?').get(Number(req.params.nid));
    if (!novel) throw fail(404, 'Novel not found.');
    if (!canManageNovel(req.user, novel)) throw fail(403, 'You can only manage your own novels.');
    require('./update-requests').clear(novel.id);
    req.flash('ok', `Marked as seen: “${novel.title}”. New requests will show up again. Releasing a chapter also clears the list automatically.`);
    res.redirect(A('/update-requests'));
  });

  // ---------- Novel requests from readers ----------
  app.get('/requests', (req, res) => {
    const { REQUEST_STATUS, listRequests } = require('./requests');
    const show = REQUEST_STATUS[req.query.show] ? req.query.show : 'open';
    const sort = ['week', 'all', 'new'].includes(req.query.sort) ? req.query.sort : 'week';
    const items = listRequests({ statuses: [show], sort, limit: 300 });
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM novel_requests GROUP BY status').all().map((r) => [r.status, r.n]));
    const novels = db.prepare('SELECT id, title FROM novels ORDER BY title COLLATE NOCASE').all();
    res.render('admin/requests', { items, show, sort, counts, novels, statusLabels: REQUEST_STATUS });
  });

  app.post('/requests/:rid', (req, res) => {
    const { REQUEST_STATUS } = require('./requests');
    const r = db.prepare('SELECT id FROM novel_requests WHERE id = ?').get(Number(req.params.rid));
    if (!r) throw fail(404, 'Request not found.');
    if (req.body.action === 'delete') {
      if (req.user.role !== 'admin') throw fail(403, 'Only admins can delete requests.');
      db.prepare('DELETE FROM novel_requests WHERE id = ?').run(r.id);
      req.flash('ok', 'Request deleted.');
    } else {
      const status = REQUEST_STATUS[req.body.status] ? req.body.status : 'open';
      const novelId = Number(req.body.novel_id) || null;
      if (status === 'added' && !novelId) {
        req.flash('error', 'To mark it Added, also pick which novel on the site it became, so voters get a “Read” button.');
        return res.redirect(req.get('referer')?.includes('/requests') ? req.get('referer') : A('/requests'));
      }
      if (novelId && !db.prepare('SELECT 1 FROM novels WHERE id = ?').get(novelId)) throw fail(400, 'That novel doesn’t exist.');
      db.prepare('UPDATE novel_requests SET status = ?, reply = ?, novel_id = ?, updated_at = unixepoch() WHERE id = ?')
        .run(status, String(req.body.reply || '').trim().slice(0, 500), novelId, r.id);
      req.flash('ok', 'Request updated.');
    }
    res.redirect(req.get('referer')?.includes('/requests') ? req.get('referer') : A('/requests'));
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
    const password = String(req.body.password || '') || crypto.randomBytes(9).toString('base64url');
    security.checkPasswordStrength(password, username);
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
      security.bumpTokenVersion(uid); // they log in again with their new permissions
      security.log(req, 'role_changed', { userId: uid, username: target.username, detail: `${target.role} → ${req.body.role} by ${req.user.username}` });
      req.flash('ok', `${target.username} is now ${req.body.role === 'admin' ? 'an admin' : `a ${req.body.role}`}.`);
    } else if (action === 'reset') {
      const password = crypto.randomBytes(9).toString('base64url');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), uid);
      security.bumpTokenVersion(uid, req);
      security.log(req, 'admin_reset_password', { userId: uid, username: target.username, detail: `by ${req.user.username}` });
      req.flash('ok', `New password for ${target.username}: ${password}`);
    } else if (action === 'logout') {
      security.bumpTokenVersion(uid);
      security.log(req, 'forced_logout', { userId: uid, username: target.username, detail: `by ${req.user.username}` });
      req.flash('ok', `${target.username} has been logged out on all devices.`);
    } else if (action === 'reset2fa') {
      db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup = '[]' WHERE id = ?").run(uid);
      security.bumpTokenVersion(uid);
      security.log(req, 'twofa_off', { userId: uid, username: target.username, detail: `turned off by ${req.user.username}` });
      req.flash('ok', `Two-factor login turned off for ${target.username} (and they were logged out). They can set it up again under 🔐 Security.`);
    } else if (action === 'delete') {
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
      req.flash('ok', `Deleted ${target.username}. Their novels were kept.`);
    }
    res.redirect(A('/users'));
  });

  // ---------- Security: two-factor login, devices, security log ----------
  const securityPage = (req, res, extra = {}) => {
    const me = db.prepare('SELECT totp_enabled, totp_secret, totp_backup FROM users WHERE id = ?').get(req.user.id);
    const isAdmin = req.user.role === 'admin';
    const events = db.prepare(`SELECT * FROM security_log ${isAdmin ? '' : 'WHERE user_id = ?'} ORDER BY id DESC LIMIT 150`).all(...(isAdmin ? [] : [req.user.id]));
    const staff = isAdmin ? db.prepare(`SELECT id, username, role, is_owner, totp_enabled, email,
        (SELECT MAX(created_at) FROM security_log l WHERE l.user_id = u.id AND l.event IN ('login', 'admin_login')) AS last_login
      FROM users u WHERE role != 'reader' ORDER BY is_owner DESC, role, username`).all() : [];
    const render = async () => {
      let qr = null;
      let secret = null;
      if (!me.totp_enabled && me.totp_secret) {
        secret = security.decrypt(me.totp_secret);
        const label = encodeURIComponent(`${getSettings().site_name}:${req.user.username}`);
        const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(getSettings().site_name)}&algorithm=SHA1&digits=6&period=30`;
        qr = await require('qrcode').toString(uri, { type: 'svg', margin: 1, width: 220 });
      }
      res.status(extra.error ? 400 : 200).render('admin/security', {
        me, backupLeft: JSON.parse(me.totp_backup || '[]').length, qr, secret: secret && secret.replace(/(.{4})/g, '$1 ').trim(),
        events, staff, labels: security.EVENT_LABELS, error: null, codes: null, flood: require('./ratelimit').status(),
        behindCloudflare: Boolean(req.get('cf-connecting-ip') || req.get('cf-ray')), ...extra,
      });
    };
    return render();
  };

  app.get('/security', (req, res) => securityPage(req, res));

  app.post('/security/2fa/start', (req, res) => {
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(security.encrypt(security.newTotpSecret()), req.user.id);
    res.redirect(A('/security#setup'));
  });

  app.post('/security/2fa/cancel', (req, res) => {
    db.prepare('UPDATE users SET totp_secret = NULL WHERE id = ? AND totp_enabled = 0').run(req.user.id);
    res.redirect(A('/security'));
  });

  app.post('/security/2fa/confirm', (req, res) => {
    const me = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (me.totp_enabled || !me.totp_secret) return res.redirect(A('/security'));
    const step = security.matchTotp(security.decrypt(me.totp_secret), req.body.code);
    if (step === null) return securityPage(req, res, { error: 'That code didn’t match. Type the 6-digit code your app shows right now (and check your phone’s clock is set automatically).' });
    const { codes, hashes } = security.newBackupCodes();
    db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, totp_backup = ? WHERE id = ?').run(step, JSON.stringify(hashes), req.user.id);
    security.bumpTokenVersion(req.user.id, req); // other sessions must log in again (with a code)
    req.session.mfa = 1;
    req.session.mfaAt = Date.now();
    security.log(req, 'twofa_on', { userId: req.user.id, username: req.user.username });
    req.user.totp_enabled = 1;
    return securityPage(req, res, { codes, justEnabled: true });
  });

  app.post('/security/2fa/disable', (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const { verifyPassword } = require('./auth');
    if (!verifyPassword(String(req.body.password || ''), row.password_hash)) return securityPage(req, res, { error: 'Your password is wrong.' });
    if (!security.verifySecondFactor(req.user.id, req.body.code)) return securityPage(req, res, { error: 'That two-factor code didn’t work.' });
    db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup = '[]' WHERE id = ?").run(req.user.id);
    security.log(req, 'twofa_off', { userId: req.user.id, username: req.user.username });
    req.flash('ok', 'Two-factor login is now off.');
    res.redirect(A('/security'));
  });

  app.post('/security/backup-codes', (req, res) => {
    if (!security.verifySecondFactor(req.user.id, req.body.code)) return securityPage(req, res, { error: 'That two-factor code didn’t work.' });
    const { codes, hashes } = security.newBackupCodes();
    db.prepare('UPDATE users SET totp_backup = ? WHERE id = ?').run(JSON.stringify(hashes), req.user.id);
    security.log(req, 'backup_new', { userId: req.user.id, username: req.user.username });
    return securityPage(req, res, { codes });
  });

  app.post('/security/logout-all', (req, res) => {
    security.bumpTokenVersion(req.user.id, req);
    security.log(req, 'logout_all', { userId: req.user.id, username: req.user.username });
    req.flash('ok', 'Done: every other device has been logged out.');
    res.redirect(A('/security'));
  });

  app.post('/security/settings', adminOnly, (req, res) => {
    if (!req.user.is_owner) throw fail(403, 'Only the site owner can change this.');
    saveSettings({ require_2fa: req.body.require_2fa ? '1' : '0' });
    req.flash('ok', req.body.require_2fa ? 'Two-factor login is now required for all staff. Anyone without it will be asked to set it up.' : 'Two-factor login is now optional.');
    res.redirect(A('/security'));
  });

  // ---------- Own account ----------
  app.get('/account', (req, res) => res.render('admin/account', { error: null }));
  app.post('/account', (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const { verifyPassword } = require('./auth');
    let error = null;
    if (!verifyPassword(String(req.body.current || ''), row.password_hash)) error = 'Current password is wrong.';
    else {
      try { security.checkPasswordStrength(req.body.password, req.user.username); } catch (err) { error = err.message; }
    }
    if (error) return res.status(400).render('admin/account', { error });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), req.user.id);
    security.bumpTokenVersion(req.user.id, req);
    security.log(req, 'password_changed', { userId: req.user.id, username: req.user.username });
    req.flash('ok', 'Password changed. You’ve been logged out on your other devices.');
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

  // ---------- Email (admin) ----------
  app.get('/email', adminOnly, (req, res) => {
    const counts = db.prepare('SELECT COUNT(email) AS with_email, SUM(email_verified) AS verified, COUNT(*) AS total FROM users').get();
    res.render('admin/email', { counts, configured: require('./mail').isConfigured() });
  });

  app.post('/email', adminOnly, (req, res) => {
    const s = getSettings();
    const port = Number(req.body.smtp_port) || 587;
    const from = String(req.body.smtp_from || '').trim().slice(0, 200);
    if (from && !/@/.test(from)) throw fail(400, 'The “From” address must contain an email address, e.g. TravellerMTL <no-reply@travellermtl.com>.');
    saveSettings({
      require_email: req.body.require_email ? '1' : '0',
      allow_registration: req.body.allow_registration ? '1' : '0',
      guest_chapter_limit: String(Math.min(1000, Math.max(0, Math.floor(Number(req.body.guest_chapter_limit) || 0)))),
      smtp_host: String(req.body.smtp_host || '').trim().slice(0, 200),
      smtp_port: String(port),
      smtp_user: String(req.body.smtp_user || '').trim().slice(0, 200),
      // Leave the stored password alone if the box was left empty.
      smtp_pass: req.body.smtp_pass ? String(req.body.smtp_pass) : s.smtp_pass,
      smtp_from: from,
    });
    req.flash('ok', 'Email settings saved. Send yourself a test email to check they work.');
    res.redirect(A('/email'));
  });

  app.post('/email/test', adminOnly, async (req, res) => {
    const to = String(req.body.to || '').trim();
    const mail = require('./mail');
    if (!mail.isValidEmail(to)) throw fail(400, 'Enter the email address to send the test to.');
    try {
      await mail.send({ to, subject: `Test email from ${getSettings().site_name}`, text: 'It works! Your site can send emails (account confirmations and password resets).' });
      req.flash('ok', `Test email sent to ${to}. Check the inbox (and spam folder).`);
    } catch (err) {
      req.flash('error', `Sending failed: ${err.message}`);
    }
    res.redirect(A('/email'));
  });

  // ---------- SEO (admin) ----------
  app.get('/seo', adminOnly, (req, res) => {
    const seo = require('./seo');
    const novels = db.prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n ORDER BY n.title COLLATE NOCASE`).all()
      .map((n) => ({ ...n, issues: seo.novelIssues(n) }));
    res.render('admin/seo', { novels, problems: novels.filter((n) => n.issues.length), indexnow: require('./indexnow').status() });
  });

  app.post('/seo/indexnow', adminOnly, async (req, res) => {
    const r = await require('./indexnow').run({ log: () => {} });
    req.flash(r?.result === 'ok' ? 'ok' : 'error', r ? (r.result === 'ok' ? `Sent ${r.count} page(s) to Bing and other IndexNow search engines.` : `IndexNow: ${r.result}`) : 'Nothing new to send (or the site address isn’t set up yet).');
    res.redirect(A('/seo'));
  });

  app.post('/seo', adminOnly, (req, res) => {
    const code = (v) => String(v || '').trim().replace(/^.*content=["']?([^"'\s>]+).*$/s, '$1'); // accept a pasted <meta> tag too
    const google = code(req.body.google_verification);
    const bing = code(req.body.bing_verification);
    const ga = String(req.body.ga_id || '').trim().toUpperCase();
    if (google && !/^[A-Za-z0-9_-]{10,100}$/.test(google)) throw fail(400, 'That Google verification code doesn’t look right. Paste just the code (or the whole <meta> tag).');
    if (bing && !/^[A-Za-z0-9_-]{10,100}$/.test(bing)) throw fail(400, 'That Bing verification code doesn’t look right.');
    if (ga && !/^G-[A-Z0-9]{4,15}$/.test(ga)) throw fail(400, 'Google Analytics IDs look like G-ABC123XYZ.');
    // Accept the publisher ID on its own, "pub-…", or the whole AdSense <script> snippet.
    const adsRaw = String(req.body.adsense_client || '').trim();
    const adsMatch = adsRaw.match(/(?:ca-)?pub-(\d{10,20})/);
    if (adsRaw && !adsMatch) throw fail(400, 'AdSense publisher IDs look like ca-pub-1234567890123456. You can also paste the whole AdSense code.');
    const adsense = adsMatch ? `ca-pub-${adsMatch[1]}` : '';
    saveSettings({
      site_description: String(req.body.site_description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      search_indexing: req.body.search_indexing ? '1' : '0',
      google_verification: google,
      bing_verification: bing,
      ga_id: ga,
      adsense_client: adsense,
      site_alternate_names: String(req.body.site_alternate_names || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10).join(', ').slice(0, 300),
      social_links: String(req.body.social_links || '').split(/\s+/).filter((u) => /^https?:\/\/\S+$/.test(u)).slice(0, 10).join('\n'),
    });
    req.flash('ok', 'SEO settings saved.');
    res.redirect(A('/seo'));
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
      default_theme: req.body.default_theme === 'light' ? 'light' : 'dark',
      default_role: req.body.default_role === 'translator' ? 'translator' : 'reader',
    });
    req.flash('ok', 'Settings saved.');
    res.redirect(A('/settings'));
  });

  // ---------- System: updates & backups (admin) ----------
  app.get('/system', adminOnly, async (req, res) => {
    const info = await system.info(req.query.check === '1');
    res.render('admin/system', { info, update: system.status(), last: system.lastUpdate(), bundled: content.importedPackages() });
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
