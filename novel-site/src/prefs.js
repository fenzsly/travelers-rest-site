// Reader settings saved on the account (theme, font, size…), so they follow the reader to every device.
const { db } = require('./db');

const CHOICES = {
  theme: ['dark', 'light'],
  rtheme: ['', 'light', 'sepia', 'green', 'dark', 'black'],
  font: ['serif', 'sans', 'mono', 'dyslexic'],
  align: ['left', 'justify'],
  autonext: ['on', 'off'],
};
const RANGES = { size: [13, 32], line: [1.2, 2.6], width: [500, 1400] };

/** Keep only known settings with allowed values. */
function cleanPrefs(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (typeof input[key] === 'string' && allowed.includes(input[key])) out[key] = input[key];
  }
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const n = Number(input[key]);
    if (input[key] !== undefined && input[key] !== '' && Number.isFinite(n)) out[key] = Math.round(Math.min(max, Math.max(min, n)) * 10) / 10;
  }
  return out;
}

function parsePrefs(json) {
  try { return cleanPrefs(JSON.parse(json || '{}')); } catch { return {}; }
}

/** Merge changes into the saved settings. Returns the new settings. */
function savePrefs(userId, changes, { replace = false } = {}) {
  const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(userId);
  const prefs = cleanPrefs({ ...(replace ? {} : parsePrefs(row?.prefs)), ...cleanPrefs(changes) });
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), userId);
  return prefs;
}

module.exports = { cleanPrefs, parsePrefs, savePrefs };
