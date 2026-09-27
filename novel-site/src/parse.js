// Turns uploaded files / pasted text into chapter objects:
//   { number, title, content (sanitized HTML), wordCount, source }
const path = require('node:path');
const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const mammoth = require('mammoth');

const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'hr', 'em', 'strong', 'i', 'b', 'u', 's', 'del', 'sup', 'sub', 'small', 'span',
    'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'center',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ruby', 'rt', 'rp',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['class'],
  },
  allowedClasses: { '*': ['tl-note', 'system', 'center', 'divider'] },
  allowedSchemes: ['http', 'https'],
  transformTags: {
    h1: 'h2',
    div: 'p',
    a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener', target: '_blank' }),
  },
  exclusiveFilter: (frame) => frame.tag === 'p' && !frame.text.trim() && !frame.mediaChildren.length,
};
SANITIZE_OPTIONS.allowedAttributes.a.push('rel', 'target');

function sanitize(html) {
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function textToHtml(text) {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  // Blank-line separated paragraphs when present; otherwise one paragraph per line.
  const blocks = /\n\s*\n/.test(normalized) ? normalized.split(/\n\s*\n/) : normalized.split('\n');
  return blocks
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => (/^([*\-_=~]\s*){3,}$/.test(b) ? '<hr>' : `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`))
    .join('\n');
}

function wordCount(html) {
  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
  // CJK characters count individually; everything else by whitespace-separated words.
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  const words = text.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + words;
}

const HEADING_RE = /^\s*(?:chapter|chap\.?|ch\.?|episode|ep\.?|第)\s*(\d+(?:\.\d+)?)\s*(?:章|话|話)?\s*(?:[:.\-–—|]\s*)?(.*)$/i;
const SPECIAL_RE = /^\s*(prologue|epilogue|side story|extra|interlude|afterword)\b\s*(?:[:.\-–—|]\s*)?(.*)$/i;

/**
 * Interpret a heading line like "Chapter 12 - The Gate" -> { number: 12, title: "The Gate" }.
 * Returns null if the line does not look like a chapter heading.
 */
function parseHeading(line) {
  const clean = line.replace(/^#+\s*/, '').trim();
  if (!clean || clean.length > 200) return null;
  let m = clean.match(HEADING_RE);
  if (m) return { number: parseFloat(m[1]), title: m[2].trim() };
  m = clean.match(SPECIAL_RE);
  if (m) {
    const word = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return { number: null, title: m[2].trim() ? `${word} — ${m[2].trim()}` : word };
  }
  return null;
}

function numberFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const m = base.match(HEADING_RE) || base.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return parseFloat(m[1]);
}

/** Pull the first heading (h1-h4 or first short paragraph) out of an HTML body as the chapter title. */
function extractTitleFromHtml(html) {
  const m = html.match(/^\s*<(h[1-4]|p)[^>]*>([\s\S]*?)<\/\1>/i);
  if (!m) return { heading: null, body: html };
  const text = sanitizeHtml(m[2], { allowedTags: [], allowedAttributes: {} }).replace(/&amp;/g, '&').trim();
  const isHeadingTag = m[1].toLowerCase() !== 'p';
  // A plain paragraph only counts as a heading if it is short and not a sentence.
  const headingLike = isHeadingTag || (text.length <= 100 && !/[.!?…。]["'”’]?\s+\S/.test(text));
  const parsed = headingLike ? parseHeading(text) : null;
  if (parsed) return { heading: parsed, body: html.slice(m[0].length) };
  if (isHeadingTag && text.length <= 200) return { heading: { number: null, title: text }, body: html.slice(m[0].length) };
  return { heading: null, body: html };
}

async function fileToHtml(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const text = () => file.buffer.toString('utf8').replace(/^﻿/, '');
  switch (ext) {
    case '.txt':
    case '.text':
      return textToHtml(text());
    case '.md':
    case '.markdown':
      return marked.parse(text());
    case '.html':
    case '.htm':
    case '.xhtml': {
      const raw = text();
      const body = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      return body ? body[1] : raw;
    }
    case '.docx': {
      const { value } = await mammoth.convertToHtml({ buffer: file.buffer });
      return value;
    }
    default:
      throw new Error(`Unsupported file type "${ext}" (${file.originalname})`);
  }
}

function buildChapter({ number, title, html, source }) {
  const content = sanitize(html);
  return { number, title: (title || '').slice(0, 250), content, wordCount: wordCount(content), source };
}

/** One file = one chapter. */
async function parseFilesAsChapters(files) {
  const out = [];
  const errors = [];
  for (const file of files) {
    try {
      const html = sanitize(await fileToHtml(file));
      const { heading, body } = extractTitleFromHtml(html);
      const number = heading?.number ?? numberFromFilename(file.originalname);
      const title = heading?.title ?? '';
      out.push(buildChapter({ number, title, html: body, source: file.originalname }));
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { chapters: out, errors };
}

/**
 * Split a single document into many chapters using heading lines.
 * `pattern` is an optional user-supplied regex source; matching lines start a new chapter.
 */
function splitTextIntoChapters(text, { pattern, source = 'pasted text' } = {}) {
  let custom = null;
  if (pattern) {
    try {
      custom = new RegExp(pattern, 'i');
    } catch {
      throw new Error('Invalid split pattern (must be a valid regular expression)');
    }
  }
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let current = null;
  const flush = () => {
    if (current && current.lines.join('').trim()) {
      chapters.push(buildChapter({
        number: current.number,
        title: current.title,
        html: textToHtml(current.lines.join('\n')),
        source,
      }));
    }
  };
  for (const line of lines) {
    let heading = null;
    if (custom) {
      if (custom.test(line)) heading = parseHeading(line) || { number: null, title: line.trim() };
    } else {
      heading = parseHeading(line);
    }
    if (heading) {
      flush();
      current = { number: heading.number, title: heading.title, lines: [] };
    } else {
      if (!current) current = { number: null, title: '', lines: [] };
      current.lines.push(line);
    }
  }
  flush();
  return chapters;
}

async function parseSingleDocument(file, options) {
  const ext = path.extname(file.originalname).toLowerCase();
  let text;
  if (ext === '.docx') {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    text = value;
  } else if (['.html', '.htm', '.xhtml'].includes(ext)) {
    // Keep paragraph breaks, drop markup.
    const html = file.buffer.toString('utf8').replace(/<\/(p|div|h[1-6]|li)>|<br\s*\/?>/gi, '\n\n');
    text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  } else {
    text = file.buffer.toString('utf8');
  }
  return splitTextIntoChapters(text, { ...options, source: file.originalname });
}

/** Fill in missing chapter numbers sequentially, continuing after `startAfter`. */
function assignMissingNumbers(chapters, startAfter = 0) {
  let last = startAfter;
  for (const ch of chapters) {
    if (ch.number == null || Number.isNaN(ch.number)) ch.number = Math.floor(last) + 1;
    last = ch.number;
  }
  return chapters;
}

module.exports = {
  sanitize, textToHtml, wordCount, parseHeading, numberFromFilename,
  parseFilesAsChapters, splitTextIntoChapters, parseSingleDocument, assignMissingNumbers,
};
