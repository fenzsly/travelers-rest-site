// Self-update (git pull + npm ci + restart) and database backups for the admin panel.
// Updating relies on the service manager (systemd `Restart=always`) to start the site again after it exits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { db } = require('./db');

const APP_DIR = path.join(__dirname, '..');
const state = { running: false, log: [], finishedAt: null, ok: null };

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: APP_DIR, timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { output: `${stdout}${stderr}`.trim() }));
      resolve(stdout.trim());
    });
  });
}

async function gitInfo() {
  try {
    const [commit, branch, date, subject] = await Promise.all([
      run('git', ['rev-parse', '--short', 'HEAD']),
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
      run('git', ['log', '-1', '--format=%cI']),
      run('git', ['log', '-1', '--format=%s']),
    ]);
    return { commit, branch, date, subject };
  } catch {
    return null;
  }
}

/** Version info; with `check`, also fetches from GitHub to list pending updates. */
async function info(check = false) {
  const git = await gitInfo();
  const result = { git, canUpdate: !!git, pending: null, checkError: null, node: process.version, uptime: process.uptime() };
  if (git && check) {
    try {
      await run('git', ['fetch', '--quiet', 'origin', git.branch]);
      const log = await run('git', ['log', '--format=%h|%cI|%s', `HEAD..origin/${git.branch}`]);
      result.pending = log ? log.split('\n').map((l) => { const [hash, date, ...s] = l.split('|'); return { hash, date, subject: s.join('|') }; }) : [];
      result.whatsNew = result.pending.length ? await pendingChangelog(`origin/${git.branch}`) : [];
    } catch (err) {
      result.checkError = (err.output || err.message).slice(0, 500);
    }
  }
  try {
    const dbFile = db.prepare('PRAGMA database_list').get().file;
    result.dbSize = fs.statSync(dbFile).size;
  } catch { /* ignore */ }
  return result;
}

// ---------- Update history (CHANGELOG.json, written with each update) ----------
db.exec(`CREATE TABLE IF NOT EXISTS update_history (
  id           TEXT PRIMARY KEY,   -- changelog entry id
  installed_at INTEGER             -- when this site first ran the update (NULL = before the log existed)
)`);

function parseChangelog(text) {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list.filter((e) => e && e.id && e.date && Array.isArray(e.changes)) : [];
  } catch {
    return [];
  }
}

/** Every update in this version's changelog, newest first, with when it was installed here. */
function changelog() {
  let entries = [];
  try { entries = parseChangelog(fs.readFileSync(path.join(APP_DIR, 'CHANGELOG.json'), 'utf8')); } catch { /* none */ }
  const seen = Object.fromEntries(db.prepare('SELECT id, installed_at FROM update_history').all().map((r) => [r.id, r.installed_at]));
  return entries.map((e) => ({ ...e, installed_at: seen[e.id] ?? null }));
}

/** On start-up: note the install time of updates this site hasn't run before. */
function recordInstalledUpdates() {
  const entries = changelog();
  const firstRun = !db.prepare('SELECT 1 FROM update_history LIMIT 1').get();
  const ins = db.prepare('INSERT OR IGNORE INTO update_history (id, installed_at) VALUES (?, ?)');
  const now = Math.floor(Date.now() / 1000);
  // The very first time, only the newest entry was just installed; older ones came before the log existed.
  entries.forEach((e, i) => ins.run(e.id, firstRun && i > 0 ? null : now));
}
recordInstalledUpdates();

/** Changelog entries in the version waiting on GitHub that aren't installed yet. */
async function pendingChangelog(ref) {
  try {
    const have = new Set(changelog().map((e) => e.id));
    return parseChangelog(await run('git', ['show', `${ref}:./CHANGELOG.json`])).filter((e) => !have.has(e.id));
  } catch {
    return [];
  }
}

function status() {
  return { running: state.running, ok: state.ok, finishedAt: state.finishedAt, log: state.log.slice(-40) };
}

const LAST_UPDATE_FILE = () => path.join(require('./db').DATA_DIR, 'last-update.json');

/** The version the site was on before the most recent update, if an undo is possible. */
function lastUpdate() {
  try {
    return JSON.parse(fs.readFileSync(LAST_UPDATE_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Switch the code to `target` (a commit, or null for the latest on the branch), install dependencies and restart.
 * Before a normal update, remembers the current version and snapshots the database so it can be undone.
 */
function runJob(kind, target) {
  if (state.running) return;
  Object.assign(state, { running: true, ok: null, finishedAt: null, log: [] });
  const say = (line) => state.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  (async () => {
    const { branch } = await gitInfo();
    const before = await run('git', ['rev-parse', 'HEAD']);
    if (kind === 'update') {
      say(`Fetching latest code for branch "${branch}"…`);
      await run('git', ['fetch', 'origin', branch]);
      target = `origin/${branch}`;
    } else {
      say(`Going back to the previous version ${target.slice(0, 7)}…`);
    }
    const after = await run('git', ['rev-parse', target]);
    if (before === after) {
      say('Already on that version. Nothing to do.');
      Object.assign(state, { running: false, ok: true, finishedAt: Date.now() });
      return;
    }
    if (kind === 'update') {
      const snapshot = path.join(require('./db').DATA_DIR, 'backups', `before-update-${before.slice(0, 7)}.db`);
      fs.mkdirSync(path.dirname(snapshot), { recursive: true });
      fs.rmSync(snapshot, { force: true });
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      say('Saved a database snapshot.');
    }
    await run('git', ['reset', '--hard', after]);
    fs.writeFileSync(LAST_UPDATE_FILE(), JSON.stringify(
      kind === 'update' ? { from: before, to: after, at: Date.now() } : { undone: true, from: after, to: before, at: Date.now() },
    ));
    say(`Code is now at ${after.slice(0, 7)}. Installing dependencies…`);
    await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { env: { ...process.env, HOME: process.env.HOME || APP_DIR } });
    say('Done. Restarting the site…');
    Object.assign(state, { ok: true, finishedAt: Date.now() });
    // Give the admin page a moment to read the final status, then let systemd restart us.
    setTimeout(() => process.exit(0), 1500);
  })().catch((err) => {
    say(`${kind === 'update' ? 'Update' : 'Undo'} failed: ${(err.output || err.message).slice(0, 800)}`);
    Object.assign(state, { running: false, ok: false, finishedAt: Date.now() });
  });
}

function startUpdate() {
  runJob('update');
}

/** Go back to the version from before the last update. Returns false if there is nothing to undo. */
function undoLastUpdate() {
  const last = lastUpdate();
  if (!last || last.undone || !/^[0-9a-f]{40}$/.test(last.from)) return false;
  runJob('undo', last.from);
  return true;
}

/** Consistent snapshot of the database into a temp file (safe while the site is running). */
function backupDatabase() {
  const file = path.join(os.tmpdir(), `novel-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

// ---------- Storage: disk and memory use (Admin → Update & backup) ----------
/** Total size in bytes of everything under `dir` (0 if it doesn't exist). Symlinks are not followed. */
function dirSize(dir, skip = () => false) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (skip(full)) continue;
    try {
      if (e.isDirectory()) total += dirSize(full, skip);
      else if (e.isFile()) total += fs.statSync(full).size;
    } catch { /* vanished or unreadable */ }
  }
  return total;
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Memory the system can still hand out (MemAvailable on Linux, else free memory). */
function availableMemory() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
    if (m) return Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  return os.freemem();
}

const BACKUP_DIR = () => path.join(require('./db').DATA_DIR, 'backups');

/** Backup files, newest first. */
function backupFiles() {
  try {
    return fs.readdirSync(BACKUP_DIR(), { withFileTypes: true }).filter((e) => e.isFile())
      .map((e) => { const st = fs.statSync(path.join(BACKUP_DIR(), e.name)); return { name: e.name, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

let storageCache = null;
/** Disk space of the server and what this site uses. Walking folders takes a moment, so it's cached for 2 minutes. */
function storage(fresh = false) {
  if (!fresh && storageCache && storageCache.at > Date.now() - 120000) return storageCache;
  const { DATA_DIR } = require('./db');
  const { UPLOAD_DIR } = require('./common');
  const dbFile = db.prepare('PRAGMA database_list').get().file;
  let disk = null;
  try {
    const st = fs.statfsSync(DATA_DIR);
    // Like `df`: space blocked off for the system (or by a quota) isn't usable, so size = used + available.
    const used = (st.blocks - st.bfree) * st.bsize;
    const free = st.bavail * st.bsize;
    disk = { total: used + free, free, used };
  } catch { /* statfs not available */ }
  const backups = backupFiles();
  const inside = (dir) => (p) => p === dir || p.startsWith(dir + path.sep);
  const parts = [
    { key: 'database', label: 'Database (novels, chapters, users, comments)', size: fileSize(dbFile) + fileSize(`${dbFile}-wal`) + fileSize(`${dbFile}-shm`) },
    { key: 'uploads', label: 'Uploaded images (covers)', size: dirSize(UPLOAD_DIR) },
    { key: 'backups', label: `Backups on the server (${backups.length} file${backups.length === 1 ? '' : 's'})`, size: backups.reduce((a, b) => a + b.size, 0) },
    { key: 'code', label: 'Site code and its version history', size: dirSize(APP_DIR, (p) => inside(path.join(APP_DIR, 'node_modules'))(p) || inside(path.join(APP_DIR, '.git'))(p) || inside(UPLOAD_DIR)(p) || inside(DATA_DIR)(p)) + dirSize(path.join(APP_DIR, '..', '.git')) },
    { key: 'modules', label: 'Code libraries (node_modules)', size: dirSize(path.join(APP_DIR, 'node_modules')) },
  ];
  const site = parts.reduce((a, p) => a + p.size, 0);
  const memTotal = os.totalmem();
  storageCache = {
    at: Date.now(), disk, parts, site, backups,
    memory: { total: memTotal, available: availableMemory(), site: process.memoryUsage().rss },
  };
  return storageCache;
}

/** Delete all but the newest `keep` backup files on the server. Returns { deleted, freed }. */
function pruneBackups(keep = 3) {
  let deleted = 0;
  let freed = 0;
  for (const f of backupFiles().slice(keep)) {
    try { fs.rmSync(path.join(BACKUP_DIR(), f.name)); deleted++; freed += f.size; } catch { /* ignore */ }
  }
  storageCache = null;
  return { deleted, freed };
}

module.exports = { storage, pruneBackups, info, changelog, status, startUpdate, undoLastUpdate, lastUpdate, backupDatabase };
