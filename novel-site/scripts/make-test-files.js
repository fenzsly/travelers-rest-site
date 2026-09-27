// Builds upload files for a novel module: an .epub and a .zip of .txt chapters (in Volume folders when set).
//   node scripts/make-test-files.js <output folder> [path/to/novel.js]   (default: the built-in sample novel)
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const demo = require(process.argv[3] ? path.resolve(process.argv[3]) : '../src/demo-novel');

const out = process.argv[2] || '.';
fs.mkdirSync(out, { recursive: true });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const heading = (c) => `${c.volume ? `Volume ${c.volume} ` : ''}Chapter ${c.number}: ${c.title}`;

// ZIP: one .txt per chapter, in Volume folders.
const zipFiles = {};
for (const c of demo.chapters) {
  zipFiles[`${c.volume ? `Volume ${c.volume}/` : ''}ch${String(c.number).padStart(3, '0')}.txt`] = strToU8(`Chapter ${c.number}: ${c.title}\n\n${c.text}\n`);
}
const base = process.argv[3] ? demo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'test-novel';
fs.writeFileSync(path.join(out, `${base}-chapters.zip`), zipSync(zipFiles));

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
fs.writeFileSync(path.join(out, `${base}.epub`), zipSync(files));
console.log(`Wrote ${base}.epub and ${base}-chapters.zip to ${out}`);
