// Builds upload test files for the sample novel: an .epub and a .zip of .txt chapters (in Volume folders).
//   node scripts/make-test-files.js <output folder>
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const demo = require('../src/demo-novel');

const out = process.argv[2] || '.';
fs.mkdirSync(out, { recursive: true });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const heading = (c) => `Volume ${c.volume} Chapter ${c.number}: ${c.title}`;

// ZIP: one .txt per chapter, in Volume folders.
const zipFiles = {};
for (const c of demo.chapters) {
  zipFiles[`Volume ${c.volume}/ch${String(c.number).padStart(3, '0')}.txt`] = strToU8(`Chapter ${c.number}: ${c.title}\n\n${c.text}\n`);
}
fs.writeFileSync(path.join(out, 'test-novel-chapters.zip'), zipSync(zipFiles));

// EPUB 3 with a nav document.
const para = (t) => t.split(/\n\s*\n/).map((p) => (p.trim() === '***' ? '<hr/>' : `<p>${esc(p.trim())}</p>`)).join('\n');
const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(title)}</title></head><body>${body}</body></html>`;
const files = {
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'OEBPS/title.xhtml': strToU8(xhtml(demo.title, `<h1>${esc(demo.title)}</h1><p>${esc(demo.author)}</p>`)),
};
const items = ['<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>', '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
const spine = ['<itemref idref="title"/>'];
const navLinks = [];
for (const c of demo.chapters) {
  const id = `c${c.number}`;
  files[`OEBPS/${id}.xhtml`] = strToU8(xhtml(heading(c), `<h2>${esc(heading(c))}</h2>\n${para(c.text)}`));
  items.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
  spine.push(`<itemref idref="${id}"/>`);
  navLinks.push(`<li><a href="${id}.xhtml">${esc(heading(c))}</a></li>`);
}
files['OEBPS/nav.xhtml'] = strToU8(xhtml('Contents', `<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>${navLinks.join('')}</ol></nav>`));
files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">travellermtl-test-novel</dc:identifier><dc:title>${esc(demo.title)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
<manifest>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
fs.writeFileSync(path.join(out, 'test-novel.epub'), zipSync(files));
console.log(`Wrote test-novel.epub and test-novel-chapters.zip to ${out}`);
