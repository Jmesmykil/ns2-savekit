#!/usr/bin/env node
// Which titles have save data, for which accounts, and how big.
//
//   node inventory.cjs <run-directory> [uid-hex ...]
//
// Probes every installed application against every account with a read-only
// listing. Nothing is downloaded and nothing is written. Sorted by size, because
// the directory API gives names and sizes but no timestamps: the save-extra-data
// command that carries them needs a save id from the save-info reader, which this
// context is denied (see RESULTS.md).
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const titles = require('./lib/titles.cjs');

const TOOLS = __dirname;
const run = (script, args) => spawnSync(process.execPath, [path.join(TOOLS, script), ...args],
  {encoding: 'utf8'});

function applications(session) {
  const out = run('list-apps.cjs', [session]).stdout || '';
  return [...new Set([...out.matchAll(/0x([0-9a-f]{16})/g)].map(m => m[1]))];
}

function accounts(session) {
  const out = run('save-pull-root.cjs', [session, '0000000000000000', '.', '--list-uids']).stdout || '';
  return [...new Set(out.split('\n').map(s => s.trim()).filter(s => /^[0-9a-f]{32}$/i.test(s)))];
}

// Writability is a policy list, not something the console reports: config/
// titles.local.json (this console) plus the titles.json template.
function writable() {
  const ids = new Set();
  for (const name of ['titles.json', 'titles.local.json']) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(TOOLS, '..', 'config', name), 'utf8'));
      for (const entry of config.write || []) ids.add(String(entry.id).toLowerCase());
    } catch { /* optional */ }
  }
  return ids;
}

function main() {
  const [session, ...uidArgs] = process.argv.slice(2);
  if (!session) {
    console.error('usage: node inventory.cjs <run-directory> [uid-hex ...]');
    process.exit(2);
  }
  const apps = applications(session);
  const uids = uidArgs.length ? uidArgs : accounts(session);
  if (apps.length === 0 || uids.length === 0) {
    console.error('could not list applications or accounts - is the session live?');
    process.exit(1);
  }
  const allowed = writable();
  titles.refresh().then(() => {
    const rows = [];
    for (const appId of apps) {
      for (let i = 0; i < uids.length; i++) {
        const result = run('save-pull-root.cjs', [session, appId, '.', uids[i], '--list-only']);
        const match = /listed (\d+) files, (\d+) bytes/.exec(result.stdout || '');
        if (!match) continue;
        rows.push({
          game: titles.name(appId) || appId,
          id: appId,
          user: i + 1,
          uid: uids[i],
          files: Number(match[1]),
          bytes: Number(match[2]),
          writable: allowed.has(appId.toLowerCase()),
          state: Number(match[1]) === 0 ? 'empty' : (Number(match[1]) < 3 ? 'sparse' : 'ok'),
        });
      }
    }
    if (rows.length === 0) {
      console.log('no save data found for any installed application');
      return;
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    const wide = Math.max(...rows.map(r => r.game.length));
    console.log('  game'.padEnd(wide + 2) + '  user  files      size  state  id');
    console.log('  ' + '-'.repeat(wide) + '  ----  -----  --------  -----  ----------------');
    for (const row of rows) {
      console.log((row.writable ? '✔ ' : '  ') + row.game.padEnd(wide) + '  ' + String(row.user).padStart(4) + '  ' +
        String(row.files).padStart(5) + '  ' + (row.bytes / 1048576).toFixed(1).padStart(6) + 'M  ' +
        row.state.padEnd(5) + '  ' + row.id);
    }
    const total = rows.reduce((sum, row) => sum + row.bytes, 0);
    console.log(`\n${rows.length} save archives, ${(total / 1048576).toFixed(1)} MiB total`);
    console.log('✔ = the id is in config/titles.local.json, so it may be written to');
  });
}

main();
