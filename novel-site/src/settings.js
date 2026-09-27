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

function saveSettings(values) {
  for (const key of Object.keys(DEFAULTS)) {
    if (values[key] !== undefined) upsert.run(key, String(values[key]));
  }
  cache = null;
}

module.exports = { getSettings, saveSettings, DEFAULTS };
