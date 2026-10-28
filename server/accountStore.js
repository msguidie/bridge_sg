// ═══════════════════════════════════════════════════════════
// Account persistence. The local JSON file is only a cache: Render's free
// tier wipes the disk on every redeploy, restart and spin-down. When replay
// archiving is configured (REPLAY_GITHUB_*), accounts are also kept in
// <REPLAY_GITHUB_DIR>/accounts.json in that repo and merged on every sync.
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const replayGithub = require('./replayGithub');

const DATA_FILE = path.join(__dirname, 'data', 'accounts.json');
const ATTEMPTS = 3;

// Null prototype so names like "constructor" never resolve to Object.prototype.
const accounts = Object.create(null);

let syncing = false;
let dirty = false;

function log(message) {
  console.log(`[accounts] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function remotePath(client) {
  return `${client.dir}/accounts.json`;
}

function isAccount(value) {
  return !!value && typeof value === 'object' && typeof value.username === 'string';
}

// Accepts the local file ({ name: account }) or the GitHub copy ({ v, accounts: [] }).
function toMap(json) {
  const list = Array.isArray(json?.accounts)
    ? json.accounts
    : json && typeof json === 'object'
      ? Object.values(json)
      : [];
  const map = Object.create(null);
  for (const acct of list) {
    if (isAccount(acct)) map[acct.username] = acct;
  }
  return map;
}

// Union of both sides; per name the copy with more games played wins, ties go to `preferred`.
function mergeAccounts(base, preferred) {
  const merged = Object.create(null);
  for (const acct of Object.values(base || {})) {
    if (isAccount(acct)) merged[acct.username] = acct;
  }
  for (const acct of Object.values(preferred || {})) {
    if (!isAccount(acct)) continue;
    const other = merged[acct.username];
    if (!other || (acct.gamesPlayed || 0) >= (other.gamesPlayed || 0)) merged[acct.username] = acct;
  }
  return merged;
}

function replaceAll(map) {
  for (const [name, acct] of Object.entries(map)) accounts[name] = acct;
}

function writeLocal() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
  } catch (err) {
    log(`local save failed: ${err.message}`);
  }
}

function loadLocal() {
  try {
    if (fs.existsSync(DATA_FILE)) replaceAll(toMap(JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))));
  } catch (err) {
    log(`local load failed: ${err.message}`);
  }
}

// Resolves once the GitHub copy has been merged in (or could not be read);
// never rejects. Request handlers await it so nobody logs in against an empty list.
const ready = (async () => {
  loadLocal();
  const client = replayGithub.getClient();
  if (!client.enabled) return;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const file = await client.getFile(remotePath(client));
      if (file) {
        replaceAll(mergeAccounts(toMap(file.json), accounts));
        writeLocal();
      }
      log(`loaded ${Object.keys(accounts).length} accounts (${file ? 'from GitHub' : 'no GitHub copy yet'})`);
      return;
    } catch (err) {
      log(`GitHub load attempt ${attempt}/${ATTEMPTS} failed: ${err.message}`);
      if (attempt < ATTEMPTS) await sleep(500 * attempt);
    }
  }
  log('continuing with local accounts; the next save merges with GitHub');
})();

async function pushToGithub() {
  const client = replayGithub.getClient();
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      let next = null;
      const res = await client.updateJson(
        remotePath(client),
        current => {
          next = mergeAccounts(toMap(current), accounts);
          const list = Object.values(next).sort((a, b) => a.username.localeCompare(b.username));
          return { v: 1, accounts: list };
        },
        'accounts: sync',
      );
      if (res && res.ok) {
        // Pick up accounts only GitHub knew about without losing changes made meanwhile.
        replaceAll(mergeAccounts(next, accounts));
        return;
      }
      log(`GitHub sync attempt ${attempt}/${ATTEMPTS} not saved${res && res.conflict ? ' (conflict)' : ''}`);
    } catch (err) {
      log(`GitHub sync attempt ${attempt}/${ATTEMPTS} failed: ${err.message}`);
    }
    if (attempt < ATTEMPTS) await sleep(500 * attempt);
  }
  log('GitHub sync gave up; the next change retries');
}

// Coalesces bursts of changes into one write at a time.
function scheduleSync() {
  if (!replayGithub.getClient().enabled) return;
  dirty = true;
  if (syncing) return;
  syncing = true;
  (async () => {
    try {
      await ready;
      while (dirty) {
        dirty = false;
        await pushToGithub();
      }
    } finally {
      syncing = false;
    }
  })();
}

function save() {
  writeLocal();
  scheduleSync();
}

module.exports = {
  accounts,
  ready,
  save,
  mergeAccounts,
  toMap,
};
