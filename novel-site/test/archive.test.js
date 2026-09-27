const test = require('node:test');
const assert = require('node:assert');
const { zipSync, strToU8 } = require('fflate');
const p = require('../src/parse');

const file = (name, data) => ({ originalname: name, buffer: Buffer.from(data) });

test('zip of chapter files becomes one chapter per file, junk skipped', async () => {
  const zip = zipSync({
    'book/ch2.txt': strToU8('Chapter 2: Second\n\nThe road bent north.'),
    'book/ch1.txt': strToU8('Chapter 1: First\n\nThe lantern was lit.'),
    'book/notes.pdf': strToU8('ignored'),
    '__MACOSX/book/._ch1.txt': strToU8('junk'),
  });
  const { chapters, errors } = await p.parseFilesAsChapters([file('novel.zip', zip)]);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(chapters.map((c) => [c.number, c.title]), [[1, 'First'], [2, 'Second']]);
  assert.match(chapters[0].source, /^novel\.zip › ch1\.txt$/);
});

function makeEpub() {
  const para = (t) => `<p>${t}</p>`.repeat(3);
  const xhtml = (title, body) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<package><manifest>
      <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
      <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
      <item id="c3" href="text/c3.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="cover"/><itemref idref="nav" linear="no"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`),
    'OEBPS/cover.xhtml': strToU8(xhtml('Cover', '<img src="cover.jpg"/>')),
    'OEBPS/nav.xhtml': strToU8(xhtml('Contents', '<nav><ol><li><a href="text/c1.xhtml">Chapter 1: Mist</a></li><li><a href="text/c2.xhtml">Chapter 2: Bells</a></li><li><a href="text/c3.xhtml#s">The Ferry</a></li></ol></nav>')),
    'OEBPS/text/c1.xhtml': strToU8(xhtml('c1', `<h1>Chapter 1: Mist</h1>${para('Morning fog covered the valley road and the travellers waited.')}`)),
    'OEBPS/text/c2.xhtml': strToU8(xhtml('c2', para('Bells rang from the temple on the hill as the caravan arrived.'))),
    'OEBPS/text/c3.xhtml': strToU8(xhtml('c3', `${para('The ferryman asked for a story instead of a coin, and waited.')}<script>alert(1)</script>`)),
  });
}

test('epub: spine order, cover skipped, titles from heading or table of contents, sanitized', async () => {
  const { chapters, errors } = await p.parseFilesAsChapters([file('book.epub', makeEpub())]);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(chapters.map((c) => [c.number, c.title]), [[1, 'Mist'], [2, 'Bells'], [null, 'The Ferry']]);
  assert.ok(!chapters[0].content.includes('Chapter 1'), 'heading removed from body');
  assert.ok(!/script/i.test(chapters[2].content));
  p.assignMissingNumbers(chapters, 0);
  assert.strictEqual(chapters[2].number, 3);
});

test('epub inside a zip, and split mode accepts archives', async () => {
  const zip = zipSync({ 'vol1.epub': makeEpub(), 'extra/ch10.txt': strToU8('Chapter 10: Extra\n\nA bonus scene.') });
  const { chapters } = await p.parseFilesAsChapters([file('all.zip', zip)]);
  assert.strictEqual(chapters.length, 4);
  const split = await p.parseSingleDocument(file('big.zip', zipSync({ 'all.txt': strToU8('Chapter 1: A\n\nx\n\nChapter 2: B\n\ny') })), {});
  assert.deepStrictEqual(split.map((c) => c.title), ['A', 'B']);
});

test('broken archives give a clear error', async () => {
  const { chapters, errors } = await p.parseFilesAsChapters([file('bad.zip', 'not a zip'), file('bad.epub', zipSync({ 'x.txt': strToU8('hi') }))]);
  assert.strictEqual(chapters.length, 0);
  assert.strictEqual(errors.length, 2);
  assert.match(errors[0], /Could not open the archive/);
  assert.match(errors[1], /not a valid EPUB/);
});
