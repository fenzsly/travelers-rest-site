// Search-engine helpers: meta descriptions, page titles and schema.org structured data (JSON-LD).
const { formatNumber, chapterLabel } = require('./util');

/** Plain text from HTML, with whitespace collapsed. */
function plainText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shorten to at most `max` characters at a word boundary (search engines show ~155). */
function excerpt(text, max = 155) {
  const t = plainText(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—–-]+$/, '')}…`;
}

/** JSON-LD for a <script type="application/ld+json"> tag, safe to embed in HTML. */
function jsonLd(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function isoDate(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : undefined;
}

function breadcrumbs(base, items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: base + url })),
  };
}

/** Split a setting into a clean list (undefined when empty, so it's left out of the JSON). */
function list(value, sep) {
  const items = String(value || '').split(sep).map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function websiteSchema(base, settings) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite', '@id': `${base}/#website`, url: `${base}/`, name: settings.site_name,
        alternateName: list(settings.site_alternate_names, ','),
        description: settings.site_description || settings.site_tagline, inLanguage: 'en',
        publisher: { '@id': `${base}/#org` },
        potentialAction: { '@type': 'SearchAction', target: `${base}/novels?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
      },
      {
        '@type': 'Organization', '@id': `${base}/#org`, name: settings.site_name, alternateName: list(settings.site_alternate_names, ','),
        url: `${base}/`, logo: `${base}/static/icons/icon-512.png`, description: settings.site_description || undefined,
        sameAs: list((list(settings.social_links, /\s+/) || []).filter((u) => /^https?:\/\//.test(u)).join(' '), ' '),
      },
    ],
  };
}

function bookSchema(base, novel, genres) {
  const url = `${base}/novel/${novel.slug}`;
  const book = {
    '@type': 'Book', '@id': `${url}#book`, name: novel.title, url,
    description: excerpt(novel.description, 500) || undefined,
    image: novel.cover ? `${base}/uploads/covers/${novel.cover}` : undefined,
    author: novel.author ? { '@type': 'Person', name: novel.author } : undefined,
    translator: novel.translator ? { '@type': 'Person', name: novel.translator } : undefined,
    alternateName: novel.alt_titles ? novel.alt_titles.split('\n').map((s) => s.trim()).filter(Boolean) : undefined,
    genre: genres.length ? genres.map((g) => g.name) : undefined,
    keywords: novel.tags || undefined,
    inLanguage: 'en',
    bookFormat: 'https://schema.org/EBook',
    creativeWorkStatus: novel.status === 'completed' ? 'Published' : 'Incomplete',
    dateModified: isoDate(novel.last_release),
    publisher: { '@id': `${base}/#org` },
  };
  if (novel.rating_count > 0) {
    book.aggregateRating = { '@type': 'AggregateRating', ratingValue: novel.rating, ratingCount: novel.rating_count, bestRating: 5, worstRating: 1 };
  }
  return {
    '@context': 'https://schema.org',
    '@graph': [book, breadcrumbs(base, [['Home', '/'], ['Novels', '/novels'], [novel.title, `/novel/${novel.slug}`]])],
  };
}

function chapterSchema(base, novel, chapter) {
  const novelUrl = `${base}/novel/${novel.slug}`;
  const url = `${novelUrl}/c/${formatNumber(chapter.number)}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Chapter', '@id': `${url}#chapter`, url, name: chapterLabel(chapter), position: formatNumber(chapter.number),
        isPartOf: { '@type': 'Book', '@id': `${novelUrl}#book`, name: novel.title, url: novelUrl },
        datePublished: isoDate(chapter.released_at), wordCount: chapter.word_count || undefined,
        image: novel.cover ? `${base}/uploads/covers/${novel.cover}` : undefined,
      },
      breadcrumbs(base, [['Home', '/'], [novel.title, `/novel/${novel.slug}`], [`Chapter ${formatNumber(chapter.number)}`, `/novel/${novel.slug}/c/${formatNumber(chapter.number)}`]]),
    ],
  };
}

/** Problems that hurt a novel's search ranking, for the admin SEO checklist. */
function novelIssues(n) {
  const issues = [];
  if (!n.cover) issues.push('No cover image');
  const desc = plainText(n.seo_description || n.description);
  if (desc.length < 120) issues.push(desc.length ? `Synopsis is short (${desc.length} characters, aim for 120+)` : 'No synopsis');
  if (!n.genre_names) issues.push('No genres');
  if (!n.chapter_count) issues.push('No published chapters');
  if ((n.seo_title || '').length > 65) issues.push('Search title is longer than 65 characters');
  if ((n.seo_description || '').length > 160) issues.push('Search description is longer than 160 characters');
  return issues;
}

module.exports = { plainText, excerpt, jsonLd, websiteSchema, bookSchema, chapterSchema, novelIssues };
