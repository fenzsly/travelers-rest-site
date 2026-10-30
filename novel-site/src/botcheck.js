// Spotting bot sign-ups. Bots that fill in sign-up forms use made-up usernames like "gnvrqjxroz":
// random letters, where most letter pairs almost never appear next to each other in real names or words.
const COMMON_PAIRS = new Set(`th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur ca el ta la ns di fo ho pe ec pr no ct us ac ot il tr ly nc et ut ss so rs un lo wa ge ie wh ee wi em ad ol rt po we na ul ni ts mo ow pa im mi ai sh ir su id os iv ia am fi ci vi pl ig tu ev ld ry mp fe bl ab gh ty op wo sa ay ex ke fr oo av ag if ap gr od bo sp rd do uc bu ei ov by rm ep tt oc fa ef cu rn sc gi da yo cr cl du ga qu ue ff ba ey ls va um pp ua up lu go ht ru ug ds lt pi rc rr eg au ck ew mu br bi pt ak pu ui rg ib tl ny ki rk ys ob mm fu ph og ms ye ud mb ip ub oi rl gu dr hr cc tw ft wn nu ka ja jo ju ze za zi ya yu ko ku ky xi ix ox ex kh zh dy`.split(/\s+/));

/** 0 = looks like a real name/word, 1 = looks like random letters. */
function randomness(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (s.length < 6) return 0;
  let rare = 0;
  for (let i = 0; i < s.length - 1; i++) if (!COMMON_PAIRS.has(s.slice(i, i + 2))) rare++;
  return rare / (s.length - 1);
}

/** A username that looks machine-made: only lowercase letters, 8–14 long, and mostly unusual letter pairs. */
function looksRandom(name) {
  return /^[a-z]{8,14}$/.test(String(name || '')) && randomness(name) >= 0.65;
}

module.exports = { randomness, looksRandom };

// ---------- Sign-up form protection (invisible to people) ----------
const { keyedHash } = require('./security');
const MIN_FILL_MS = 3000; // people need a few seconds to fill in the form; bots post instantly
const MAX_AGE_MS = 24 * 3600 * 1000;
const PER_IP_PER_DAY = 3;
const recentByIp = new Map();

/** A signed timestamp for the sign-up form, plus the value the page's script must send back. */
function signupToken() {
  const t = String(Date.now());
  const token = `${t}.${keyedHash(`signup|${t}`).slice(0, 16)}`;
  return { token, jsKey: keyedHash(`js|${t}`).slice(0, 12) };
}

/** Why this sign-up looks automated ('trap', 'too-fast', 'no-js', 'expired', 'too-many'), or null if it looks human. */
function checkSignup(req) {
  const b = req.body || {};
  if (String(b.website || '').trim()) return 'trap'; // hidden field only bots fill in
  const [t, sig] = String(b.ft || '').split('.');
  if (!t || sig !== keyedHash(`signup|${t}`).slice(0, 16)) return 'no-token';
  const age = Date.now() - Number(t);
  if (age < MIN_FILL_MS) return 'too-fast';
  if (age > MAX_AGE_MS) return 'expired';
  if (String(b.js || '') !== keyedHash(`js|${t}`).slice(0, 12).split('').reverse().join('')) return 'no-js';
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const list = (recentByIp.get(ip) || []).filter((x) => x > now - 86400000);
  if (list.length >= PER_IP_PER_DAY) return 'too-many';
  return null;
}

/** Call after an account was created, for the per-address daily limit. */
function noteSignup(req) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  recentByIp.set(ip, [...(recentByIp.get(ip) || []).filter((x) => x > now - 86400000), now]);
  if (recentByIp.size > 20000) recentByIp.clear();
}

Object.assign(module.exports, { signupToken, checkSignup, noteSignup, PER_IP_PER_DAY });
