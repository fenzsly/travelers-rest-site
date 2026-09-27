function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'novel';
}

function timeAgo(unixSeconds) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [name, secs] of units) {
    const n = Math.floor(diff / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

function formatDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** 12 -> "12", 12.5 -> "12.5" */
function formatNumber(n) {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(2));
}

function chapterLabel(ch) {
  const base = `Chapter ${formatNumber(ch.number)}`;
  return ch.title ? `${base}: ${ch.title}` : base;
}

function compactNumber(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function paginate(total, page, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page | 0 || 1), pages);
  return { total, pages, current, perPage, offset: (current - 1) * perPage };
}

/** Build a query string from the current query, overriding some keys. */
function withQuery(query, overrides) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...query, ...overrides })) {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

const STATUS_LABELS = { ongoing: 'Ongoing', completed: 'Completed', hiatus: 'On hiatus', dropped: 'Dropped' };

// Reader's own library lists.
const LIST_LABELS = { reading: 'Reading', plan: 'Plan to read', completed: 'Completed', hold: 'On hold', dropped: 'Dropped' };
const LIST_ICONS = { reading: '📖', plan: '🕒', completed: '✅', hold: '⏸', dropped: '🚫' };

/** True if a unix time is within the last `hours` hours. */
function isRecent(unixSeconds, hours = 48) {
  return Date.now() / 1000 - unixSeconds < hours * 3600;
}

module.exports = { slugify, timeAgo, formatDate, formatNumber, chapterLabel, compactNumber, paginate, withQuery, isRecent, STATUS_LABELS, LIST_LABELS, LIST_ICONS };
