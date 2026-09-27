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

function startUpdate() {
  if (state.running) return;
  Object.assign(state, { running: true, ok: null, finishedAt: null, log: [] });
  const say = (line) => state.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  (async () => {
    const { branch } = await gitInfo();
    say(`Fetching latest code for branch "${branch}"…`);
    await run('git', ['fetch', 'origin', branch]);
    const before = await run('git', ['rev-parse', '--short', 'HEAD']);
    await run('git', ['reset', '--hard', `origin/${branch}`]);
    const after = await run('git', ['rev-parse', '--short', 'HEAD']);
    if (before === after) {
      say('Already up to date. Nothing to do.');
      Object.assign(state, { running: false, ok: true, finishedAt: Date.now() });
      return;
    }
    say(`Updated ${before} → ${after}. Installing dependencies…`);
    await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { env: { ...process.env, HOME: process.env.HOME || APP_DIR } });
    say('Done. Restarting the site…');
    Object.assign(state, { ok: true, finishedAt: Date.now() });
    // Give the admin page a moment to read the final status, then let systemd restart us.
    setTimeout(() => process.exit(0), 1500);
  })().catch((err) => {
    say(`Update failed: ${(err.output || err.message).slice(0, 800)}`);
    Object.assign(state, { running: false, ok: false, finishedAt: Date.now() });
  });
}

/** Consistent snapshot of the database into a temp file (safe while the site is running). */
function backupDatabase() {
  const file = path.join(os.tmpdir(), `novel-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

module.exports = { info, status, startUpdate, backupDatabase };
