const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated database, uploads and content folder for this test file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'content-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.CONTENT_DIR = path.join(tmp, 'novels');
const pkgDir = path.join(process.env.CONTENT_DIR, 'sample');
fs.mkdirSync(pkgDir, { recursive: true });
const write = (chapters) => fs.writeFileSync(path.join(pkgDir, 'novel.json'), JSON.stringify({
  title: 'Sample Tale', genres: ['Fantasy'], status: 'ongoing', description: 'A test.',
  chapters,
}));
fs.writeFileSync(path.join(pkgDir, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const { db } = require('../src/db');
const { importBundledNovels } = require('../src/content');

test('imports a bundled novel once, then only new chapters, and respects deletion', () => {
  write([{ number: 1, title: 'One', text: 'First.\n\nMore.' }, { number: 2, title: 'Two', text: 'Second.' }]);
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), ['Added “Sample Tale” (2 chapters)']);
  const novel = db.prepare("SELECT * FROM novels WHERE title = 'Sample Tale'").get();
  assert.ok(novel.cover && fs.existsSync(path.join(process.env.UPLOAD_DIR, 'covers', novel.cover)));

  // Running again changes nothing; an edited chapter is not overwritten.
  db.prepare("UPDATE chapters SET title = 'Edited' WHERE novel_id = ? AND number = 1").run(novel.id);
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), []);

  // A later version with a new chapter only adds that chapter.
  write([{ number: 1, title: 'One', text: 'First.' }, { number: 2, title: 'Two', text: 'Second.' }, { number: 3, title: 'Three', text: 'Third.' }]);
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), ['Added 1 new chapter to “Sample Tale”']);
  const titles = db.prepare('SELECT title FROM chapters WHERE novel_id = ? ORDER BY number').all(novel.id).map((r) => r.title);
  assert.deepStrictEqual(titles, ['Edited', 'Two', 'Three']);

  // A new cover in the package replaces the bundled one…
  fs.writeFileSync(path.join(pkgDir, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), ['New cover for “Sample Tale”']);
  const newCover = db.prepare('SELECT cover FROM novels WHERE id = ?').get(novel.id).cover;
  assert.notStrictEqual(newCover, novel.cover);
  assert.ok(!fs.existsSync(path.join(process.env.UPLOAD_DIR, 'covers', novel.cover)));
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), []);
  // …but never a cover uploaded on the site.
  db.prepare("UPDATE novels SET cover = 'my-upload.png' WHERE id = ?").run(novel.id);
  fs.writeFileSync(path.join(pkgDir, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), []);
  assert.strictEqual(db.prepare('SELECT cover FROM novels WHERE id = ?').get(novel.id).cover, 'my-upload.png');

  // Deleted by an admin: stays deleted.
  db.prepare('DELETE FROM novels WHERE id = ?').run(novel.id);
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), []);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM novels WHERE title = 'Sample Tale'").get().n, 0);
});

test('the novels shipped in content/novels are valid', () => {
  const dir = path.join(__dirname, '..', 'content', 'novels');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, name, 'novel.json'), 'utf8'));
    assert.ok(d.title && Array.isArray(d.chapters) && d.chapters.length, name);
    const numbers = d.chapters.map((c) => c.number);
    assert.strictEqual(new Set(numbers).size, numbers.length, `${name}: duplicate chapter numbers`);
    for (const c of d.chapters) assert.ok(Number.isFinite(c.number) && (c.text || c.html), `${name}: chapter ${c.number}`);
  }
});

test('"original": true marks an original work once; the admin can change it afterwards', () => {
  const dir = path.join(process.env.CONTENT_DIR, 'orig');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = { title: 'My Own Story', chapters: [{ number: 1, title: 'Start', text: 'Hello.' }] };
  fs.writeFileSync(path.join(dir, 'novel.json'), JSON.stringify(pkg));
  importBundledNovels({ log: () => {} });
  const id = db.prepare("SELECT id FROM novels WHERE title = 'My Own Story'").get().id;
  assert.strictEqual(db.prepare('SELECT is_original FROM novels WHERE id = ?').get(id).is_original, 0);
  // A later version says it's an original work: applied to the existing novel.
  fs.writeFileSync(path.join(dir, 'novel.json'), JSON.stringify({ ...pkg, original: true }));
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), ['“My Own Story” is now marked as an original work']);
  const { q } = require('../src/queries');
  assert.strictEqual(q.novelBySlug.get('my-own-story').translator, null);
  // Unticked on the site: stays unticked.
  db.prepare('UPDATE novels SET is_original = 0 WHERE id = ?').run(id);
  assert.deepStrictEqual(importBundledNovels({ log: () => {} }), []);
  assert.strictEqual(db.prepare('SELECT is_original FROM novels WHERE id = ?').get(id).is_original, 0);
});
