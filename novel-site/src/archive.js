// .zip and .epub support for batch uploads.
const path = require('node:path');
const { unzipSync, strFromU8 } = require('fflate');

const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024; // guards against zip bombs
const CHAPTER_EXT = /\.(txt|text|md|markdown|html?|xhtml|docx)$/i;

class ArchiveError extends Error {}

/** Unzip, refusing archives with too many entries or too much uncompressed data. */
function safeUnzip(buffer, filter) {
  let entries = 0;
  let total = 0;
  try {
    return unzipSync(new Uint8Array(buffer), {
      filter(file) {
        if (!filter(file.name)) return false;
        entries += 1;
        total += file.originalSize;
        if (entries > MAX_ENTRIES) throw new ArchiveError(`Archive has more than ${MAX_ENTRIES} files.`);
        if (total > MAX_TOTAL_BYTES) throw new ArchiveError('Archive is too large when unpacked (over 300 MB).');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError('Could not open the archive. Is it a valid, unencrypted .zip/.epub file?');
  }
}

const skipJunk = (name) => !name.endsWith('/') && !/(^|\/)(__MACOSX|\.)/.test(name);

/** Expand a .zip into file-like objects ({ originalname, buffer }) for the chapter files inside. */
function filesFromZip(file) {
  const entries = safeUnzip(file.buffer, (name) => skipJunk(name) && (CHAPTER_EXT.test(name) || /\.epub$/i.test(name)));
  return Object.entries(entries)
    .map(([name, data]) => ({ originalname: path.posix.basename(name), fullpath: name, buffer: Buffer.from(data) }))
    .sort((a, b) => a.fullpath.localeCompare(b.fullpath, undefined, { numeric: true }));
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]) : null;
}

/**
 * Read an .epub and return its reading-order documents as { name, title, html }.
 * Uses the OPF spine for order and the navigation/NCX titles when available.
 */
function epubDocuments(file) {
  const entries = safeUnzip(file.buffer, (name) => /\.(x?html?|xml|opf|ncx)$/i.test(name));
  const read = (p) => (entries[p] ? strFromU8(entries[p]) : null);
  const container = read('META-INF/container.xml');
  const opfPath = container && attr(container.match(/<rootfile\b[^>]*>/i)?.[0] || '', 'full-path');
  const opf = opfPath && read(opfPath);
  if (!opf) throw new ArchiveError(`${file.originalname}: not a valid EPUB (missing package file).`);
  const base = path.posix.dirname(opfPath);
  const resolve = (href) => path.posix.normalize(path.posix.join(base, decodeURIComponent(href.split('#')[0])));

  const manifest = {};
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (id && href) manifest[id] = { href: resolve(href), type: attr(tag, 'media-type') || '', props: attr(tag, 'properties') || '' };
  }

  // Titles from the table of contents (EPUB 3 nav or EPUB 2 NCX), keyed by file path.
  const titles = {};
  const nav = Object.values(manifest).find((m) => /\bnav\b/.test(m.props));
  const navDoc = nav && read(nav.href);
  if (navDoc) {
    const navBase = path.posix.dirname(nav.href);
    for (const m of navDoc.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const p = path.posix.normalize(path.posix.join(navBase, decodeURIComponent(m[1].split('#')[0])));
      titles[p] ??= m[2].replace(/<[^>]+>/g, '').trim();
    }
  }
  const ncx = Object.values(manifest).find((m) => m.type === 'application/x-dtbncx+xml');
  const ncxDoc = ncx && read(ncx.href);
  if (ncxDoc) {
    const ncxBase = path.posix.dirname(ncx.href);
    for (const m of ncxDoc.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*src\s*=\s*["']([^"']+)["']/gi)) {
      const p = path.posix.normalize(path.posix.join(ncxBase, decodeURIComponent(m[2].split('#')[0])));
      titles[p] ??= m[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  const docs = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) || []) {
    if (attr(tag, 'linear') === 'no') continue;
    const item = manifest[attr(tag, 'idref')];
    if (!item || /\bnav\b/.test(item.props)) continue;
    const raw = read(item.href);
    if (!raw) continue;
    const body = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const html = body ? body[1] : raw;
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').trim();
    // Skip covers, title pages and other near-empty documents.
    if (text.length < 80) continue;
    docs.push({ name: `${file.originalname} › ${path.posix.basename(item.href)}`, title: titles[item.href] || '', html });
  }
  if (!docs.length) throw new ArchiveError(`${file.originalname}: no chapters found in this EPUB.`);
  return docs;
}

module.exports = { filesFromZip, epubDocuments, ArchiveError };
