// Site-wide settings editable from the admin panel (no config files needed).
const { db } = require('./db');

const DEFAULTS = {
  site_name: 'TravellerMTL',
  site_tagline: 'Fan translations of web novels',
  announcement: '',
  footer_text: 'All translations are unofficial fan works. Original works belong to their respective authors.',
  allow_registration: '1',
  // Role given to newly registered accounts: 'reader' or 'translator'.
  default_role: 'reader',
  comments_enabled: '1',
  // Theme new visitors see: 'dark' or 'light' (each reader can still switch).
  default_theme: 'dark',
  // --- SEO ---
  // Shown under the site name in Google results and in link previews for the home page.
  site_description: 'Read free English translations of Chinese, Korean and Japanese web novels online: fantasy, xianxia, romance, isekai and more, updated regularly.',
  search_indexing: '1', // '0' asks search engines not to index the site (e.g. before launch)
  google_verification: '',
  bing_verification: '',
  ga_id: '', // Google Analytics 4 measurement ID, e.g. G-ABC123XYZ
  // Other ways people write the site's name, so Google connects them to it (comma separated).
  site_alternate_names: 'Traveller MTL, TravellerMTL Novels, travellermtl.com',
  // Links to the site's profiles elsewhere (Discord, X, Reddit…), one per line. Helps Google recognise the brand.
  social_links: '',
  // Shown on the Contact page (optional; the contact form works without it).
  contact_email: '',
  // --- Email ---
  require_email: '0', // '1' = an email address is required to sign up
  // --- Anti-scraping (Admin → Anti-scraping). anti_scraping is the master switch for everything below. ---
  anti_scraping: '1',
  scraper_check: '1', // count downloads vs real browser opens and warn on the dashboard
  // Guests must create a free account after reading this many chapters (0 = never). Stops scrapers.
  guest_chapter_limit: '10',
  guest_ip_limit: '1', // also count guests per IP address (3× the limit), for scrapers that drop cookies
  chapter_speed_limit: '40', // max chapters anyone can open per minute (0 = no limit)
  block_ai_bots: '1', // refuse AI-training / data-harvesting bots and disallow them in robots.txt
  // Accounts can open this many different chapters per day (0 = no limit). Stops scrapers that sign up.
  account_daily_limit: '400',
  // Guests' chapter text is only sent after their browser proves it runs JavaScript (stops simple scrapers).
  browser_check: '1',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '', // e.g. TravellerMTL <no-reply@travellermtl.com>
  // --- Security ---
  require_2fa: '0', // '1' = every staff account must use two-factor login for the admin panel
  // --- Ads ---
  adsense_client: 'ca-pub-2543393434361716', // Google AdSense publisher ID (empty = no ads)
  adsense_slot: '3417963183', // display ad unit ("data-ad-slot") placed in the spots below; empty = Auto ads only
  adsense_slot_article: '2651676421', // in-article ad unit used inside chapter text (falls back to the display unit)
  // Where the ad unit appears (comma separated): chapter_end, chapter_mid, novel, home
  ad_places: 'chapter_end,chapter_mid,novel,home',
};

const selectAll = db.prepare('SELECT key, value FROM settings');
const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

let cache = null;

function getSettings() {
  if (!cache) {
    cache = { ...DEFAULTS };
    for (const row of selectAll.all()) cache[row.key] = row.value;
  }
  return cache;
}

// Secret settings are stored encrypted (see security.js); read them with security.decrypt().
const ENCRYPTED = ['smtp_pass'];

function saveSettings(values) {
  const { encrypt, isEncrypted } = require('./security');
  // Unknown keys are ignored; only settings with a default can be saved.
  for (const key of Object.keys(DEFAULTS)) {
    if (values[key] === undefined) continue;
    let value = String(values[key]);
    if (ENCRYPTED.includes(key) && value && !isEncrypted(value)) value = encrypt(value);
    upsert.run(key, value);
  }
  cache = null;
}

// Encrypt secrets saved by older versions (stored as plain text).
for (const key of ENCRYPTED) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value && !require('./security').isEncrypted(row.value)) saveSettings({ [key]: row.value });
}

// One-time change (Oct 2026): guests may read 10 chapters before signing up (was 40).
// A limit that was switched off (0) stays off.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migrated_guest_limit_10'").get()) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'guest_chapter_limit'").get();
  if (row && Number(row.value) > 10) upsert.run('guest_chapter_limit', '10');
  upsert.run('migrated_guest_limit_10', '1');
  cache = null;
}

module.exports = { getSettings, saveSettings, DEFAULTS };
