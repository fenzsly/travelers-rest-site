// Novels shipped with the site's code (content/novels/<name>/novel.json + cover image).
// They are imported when the site starts, so installing an update is enough to publish them.
//  - A new package creates the novel (owned by the site owner).
//  - Later versions of a package only add chapters whose numbers don't exist yet; edits made on the site are kept.
//  - If an admin deletes an imported novel, it is not imported again.
const fs = require('node:fs');
const path = require('node:path');
const { db, tx } = require('./db');
const { UPLOAD_DIR } = require('./common');
const { setNovelGenres } = require('./queries');
const { slugify, STATUS_LABELS } = require('./util');
const parse = require('./parse');

const CONTENT_DIR = process.env.CONTENT_DIR || path.join(__dirname, '..', 'content', 'novels');

db.exec(`
CREATE TABLE IF NOT EXISTS content_imports (
  package     TEXT PRIMARY KEY,
  novel_id    INTEGER,
  title       TEXT NOT NULL,
  chapters    INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
`);

function readPackages() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs.readdirSync(CONTENT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(CONTENT_DIR, d.name, 'novel.json')))
    .map((d) => {
      const dir = path.join(CONTENT_DIR, d.name);
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'novel.json'), 'utf8'));
      const cover = fs.readdirSync(dir).find((f) => /^cover\.(png|jpe?g|webp)$/i.test(f));
      return { name: d.name, dir, data, cover: cover ? path.join(dir, cover) : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function uniqueSlug(slug) {
  let candidate = slug;
  for (let i = 2; db.prepare('SELECT 1 FROM novels WHERE slug = ?').get(candidate); i++) candidate = `${slug}-${i}`;
  return candidate;
}

function chapterHtml(c) {
  return parse.sanitize(c.html ? c.html : parse.textToHtml(c.text || ''));
}

/** Import new bundled novels / new chapters. Returns a list of human-readable changes. */
function importBundledNovels({ log = console.log } = {}) {
  const changes = [];
  const owner = db.prepare('SELECT id FROM users WHERE is_owner = 1').get()?.id
    ?? db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()?.id ?? null;
  const insertChapter = db.prepare('INSERT INTO chapters (novel_id, number, volume, title, content, word_count, publish_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  for (const pkg of readPackages()) {
    const d = pkg.data;
    try {
      const record = db.prepare('SELECT * FROM content_imports WHERE package = ?').get(pkg.name);
      if (record && !db.prepare('SELECT 1 FROM novels WHERE id = ?').get(record.novel_id)) continue; // deleted on purpose

      tx(() => {
        let novelId = record?.novel_id;
        if (!novelId) {
          let cover = null;
          if (pkg.cover) {
            cover = `bundled-${pkg.name}${path.extname(pkg.cover).toLowerCase()}`;
            fs.mkdirSync(path.join(UPLOAD_DIR, 'covers'), { recursive: true });
            fs.copyFileSync(pkg.cover, path.join(UPLOAD_DIR, 'covers', cover));
          }
          const r = db.prepare(`INSERT INTO novels (slug, title, alt_titles, author, original_language, year, status, description, tags, cover, owner_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            uniqueSlug(slugify(d.slug || d.title)), d.title, d.alt_titles || '', d.author || '', d.original_language || '',
            d.year || null, STATUS_LABELS[d.status] ? d.status : 'ongoing', d.description || '', d.tags || '', cover, owner);
          novelId = Number(r.lastInsertRowid);
          db.prepare('UPDATE novels SET seo_title = ?, seo_description = ? WHERE id = ?').run(d.seo_title || '', d.seo_description || '', novelId);
          const genreIds = (d.genres || []).map((g) => db.prepare('SELECT id FROM genres WHERE name = ? COLLATE NOCASE').get(g)?.id).filter(Boolean);
          setNovelGenres(novelId, genreIds);
        }
        // Fill in search title/description if the package has them and they're still empty on the site.
        if (record && (d.seo_title || d.seo_description)) {
          db.prepare(`UPDATE novels SET seo_title = CASE WHEN seo_title = '' THEN ? ELSE seo_title END,
            seo_description = CASE WHEN seo_description = '' THEN ? ELSE seo_description END WHERE id = ?`).run(d.seo_title || '', d.seo_description || '', novelId);
        }
        let added = 0;
        for (const c of d.chapters || []) {
          if (db.prepare('SELECT 1 FROM chapters WHERE novel_id = ? AND number = ?').get(novelId, c.number)) continue;
          const html = chapterHtml(c);
          const publishAt = c.publish_at ? Math.floor(new Date(c.publish_at).getTime() / 1000) || null : null;
          insertChapter.run(novelId, c.number, c.volume ?? null, c.title || '', html, parse.wordCount(html), publishAt);
          added++;
        }
        if (added) db.prepare('UPDATE novels SET updated_at = unixepoch() WHERE id = ?').run(novelId);
        db.prepare(`INSERT INTO content_imports (package, novel_id, title, chapters) VALUES (?, ?, ?, ?)
          ON CONFLICT(package) DO UPDATE SET chapters = chapters + excluded.chapters, updated_at = unixepoch()`).run(pkg.name, novelId, d.title, added);
        if (!record) changes.push(`Added “${d.title}” (${added} chapters)`);
        else if (added) changes.push(`Added ${added} new chapter${added === 1 ? '' : 's'} to “${d.title}”`);
      });
    } catch (err) {
      log(`Could not import bundled novel "${pkg.name}": ${err.message}`);
    }
  }
  for (const c of changes) log(`Bundled content: ${c}`);
  return changes;
}

function importedPackages() {
  return db.prepare(`SELECT ci.*, n.slug, n.id AS live_id FROM content_imports ci LEFT JOIN novels n ON n.id = ci.novel_id
    ORDER BY ci.updated_at DESC`).all();
}

module.exports = { importBundledNovels, importedPackages, CONTENT_DIR };
