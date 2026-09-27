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

module.exports = { info, status, startUpdate, undoLastUpdate, lastUpdate, backupDatabase };
