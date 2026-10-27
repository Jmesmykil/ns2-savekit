#!/usr/bin/env node
'use strict';
// ns2-savekit: guided, interactive front end for the tools in this directory.
//
// It does not reimplement anything: every action shells out to the proven
// scripts (list-apps, find-save-uid, save-pull-root, save-write-stage,
// save-delete-root) so the safety rails - whitelist, required backup, verified
// replaces, one transaction per write - stay exactly where they were tested.
//
//   node kit.cjs [run-directory]
//
// With no argument it picks the newest run folder that has a promoted root.
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const titles = require('./lib/titles.cjs');
const ALLOWED = new Set();
try {
  const extra = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'titles.json'), 'utf8'));
  for (const entry of extra.write || []) ALLOWED.add(String(entry.id).toLowerCase());
} catch { /* allowlist file is optional */ }

const TOOLS = __dirname;
const REPO = path.resolve(TOOLS, '..');
const NOTICE = [
  'Writes are the only dangerous operation and they are fenced: disposable titles',
  'only, a backup is required, existing files are replaced only when the live bytes',
  'still match that backup, everything goes down in one commit and is hashed back.',
  'The promoted-root save path crashes the host app about 3 times in 5, so do one',
  'save operation per boot and restart the console after a crash.',
].join('\n');

function run(script, args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(TOOLS, script), ...args], {
    encoding: 'utf8',
    ...options,
  });
  return {
    ok: result.status === 0,
    out: (result.stdout || '') + (result.stderr || ''),
    stdout: result.stdout || '',
  };
}

function findRuns() {
  const root = path.join(REPO, '..');
  const candidates = [];
  for (const base of [path.join(process.cwd(), 'runs'), path.join(root, 'ns2jb-rpc', 'runs')]) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      const proof = path.join(dir, 'switch2', 'ro', 'root', 'current-root.json');
      if (fs.existsSync(proof)) {
        candidates.push({dir, when: fs.statSync(proof).mtimeMs});
      }
    }
  }
  return candidates.sort((a, b) => b.when - a.when).map(entry => entry.dir);
}

const rl = readline.createInterface({input: process.stdin, output: process.stdout});
let closed = false;
rl.on('close', () => { closed = true; });
// Lines are queued, not awaited one at a time: a piped script delivers every
// answer before the first question is printed, and rl.question would drop them.
const pending = [];
const waiting = [];
rl.on('line', line => {
  if (waiting.length) waiting.shift()(line);
  else pending.push(line);
});
function ask(question) {
  process.stdout.write(question);
  if (pending.length) return Promise.resolve(pending.shift().trim());
  if (closed) return Promise.resolve('');
  return new Promise(resolve => waiting.push(line => resolve(line.trim())));
}
async function askDefault(question, fallback) {
  const answer = await ask(`${question}${fallback ? ` [${fallback}]` : ''}: `);
  return answer === '' ? fallback : answer;
}
async function choose(question, options) {
  console.log('\n' + question);
  options.forEach((option, index) => console.log(`  ${index + 1}) ${option.label}`));
  for (;;) {
    const answer = await ask(`Number 1-${options.length} (blank = back): `);
    if (answer === '') return null;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1];
    console.log('  not a listed number');
  }
}
async function confirm(question) {
  const answer = (await ask(`${question} [y/N]: `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

// One save operation per boot is the safe limit: a second one crashes the host
// app (2162-0002) often enough that the reminder is worth printing every time.
let opsThisSession = 0;
function saveOpDone() {
  opsThisSession += 1;
  console.log(opsThisSession === 1
    ? '\nreminder: that was the first save operation in this boot. Restart the console\n' +
      'before another one - a second operation crashes the host app (2162-0002) often\n' +
      'enough that it is the default assumption.'
    : '\nreminder: ' + opsThisSession + ' save operations in this boot. If the next one fails\n' +
      'or the app crashes with 2162-0002, restart the console.');
}

function heading(text) {
  console.log('\n' + text + '\n' + '-'.repeat(text.length));
}

async function pickSession() {
  const runs = findRuns();
  if (runs.length === 0) {
    console.log('No run folder with a promoted root was found.');
    console.log('Start the exploit first:  node run.cjs --rpc <computer-ip>');
    return null;
  }
  const chosen = await choose('Which session?', [
    {label: 'newest: ' + path.basename(runs[0]), value: runs[0]},
    ...runs.slice(1, 7).map(dir => ({label: path.basename(dir) + '   ' + dir, value: dir})),
  ]);
  return chosen ? chosen.value : null;
}

async function titleRows(session) {
  const result = run('list-apps.cjs', [session]);
  if (!result.ok) {
    console.log(result.out.trim());
    return [];
  }
  const ids = [...result.out.matchAll(/0x([0-9a-f]{16})/g)].map(match => match[1]);
  await titles.refresh();
  return ids.map(id => ({
    id,
    label: (ALLOWED.has(id.toLowerCase()) ? '✔ ' : '  ') + titles.label(id),
  }));
}

async function pickTitle(session) {
  const rows = await titleRows(session);
  if (rows.length === 0) {
    console.log('No installed applications were listed.');
    return null;
  }
  const chosen = await choose('Which title?  (✔ = write-allowed)', rows);
  return chosen ? chosen.value : null;
}

async function pickUid(session, title) {
  const result = run('find-save-uid.cjs', [session, title]);
  const uids = [...result.out.matchAll(/\b([0-9a-f]{32})\b/g)].map(match => match[1]);
  const unique = [...new Set(uids)];
  if (unique.length === 1) {
    console.log('account uid: ' + unique[0]);
    return unique[0];
  }
  if (unique.length === 0) {
    console.log('Could not enumerate an account uid; pass it manually.');
    return await askDefault('account uid (32 hex chars)', '');
  }
  const chosen = await choose('Which account?', unique.map(uid => ({label: uid, value: uid})));
  return chosen ? chosen.value : null;
}

async function doBackup(session, title, uid) {
  const suggested = path.join(REPO, 'saves', title);
  const dir = await askDefault('Directory for the backup', suggested);
  if (!dir) return null;
  console.log('\npulling (read-only, never commits) ...\n');
  const result = run('save-pull-root.cjs', [session, title, dir, uid], {stdio: 'inherit'});
  if (!result.ok) {
    console.log('\npull failed - see the message above');
    return null;
  }
  console.log('\nbackup: ' + dir);
  saveOpDone();
  return dir;
}

async function writeFiles(session, title, uid, backup, manifest) {
  if (!manifest || !fs.existsSync(manifest)) {
    console.log('no such manifest: ' + manifest);
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  heading('about to write ' + parsed.files.length + ' file(s) into ' + title);
  for (const file of parsed.files) {
    console.log(`  ${file.path}${file.replace ? '   (replace, verified)' : '   (add)'}`);
  }
  if (!(await confirm('Proceed? This commits one transaction'))) return;
  const result = run('save-write-stage.cjs', [session, title, uid, backup, manifest], {stdio: 'inherit'});
  console.log(result.ok ? '\ncommitted' : '\nwrite failed - see the message above');
  saveOpDone();
}

async function writeManifest(session, title, uid, backup) {
  const manifest = await askDefault('Manifest to write (built with build-editor-manifest.py or build-untethered.sh)');
  if (!manifest) return;
  await writeFiles(session, title, uid, backup, manifest);
}

async function doDelete(session, title, uid) {
  const target = await askDefault('File to delete at the save root (e.g. /save9999.dat)');
  if (!target) return;
  if (!(await confirm('Delete ' + target + ' from ' + title))) return;
  const result = run('save-delete-root.cjs', [session, title, uid, target], {stdio: 'inherit'});
  console.log(result.ok ? '\ndeleted' : '\ndelete failed');
  saveOpDone();
}

async function installLauncher(session, title, uid, backup) {
  if (!backup) {
    console.log('A backup is required first (it is the base the launcher is built from).');
    return;
  }
  const out = path.join(REPO, 'staging', path.basename(backup));
  const built = spawnSync('/bin/sh', [path.join(TOOLS, 'build-untethered.sh'), backup, out], {encoding: 'utf8'});
  console.log((built.stdout || '') + (built.stderr || ''));
  if (built.status !== 0) return;
  await writeFiles(session, title, uid, backup, path.join(out, 'manifest.json'));
}

async function installEditor(session, title, uid, backup) {
  if (!backup) {
    console.log('A backup is required first.');
    return;
  }
  const source = await askDefault('Directory with the editor save (fetch it first)', '/tmp/seed');
  const manifest = path.join(REPO, 'staging', 'editor-manifest.json');
  fs.mkdirSync(path.dirname(manifest), {recursive: true});
  const built = spawnSync('python3', [path.join(TOOLS, 'build-editor-manifest.py'), source, backup, manifest], {encoding: 'utf8'});
  console.log((built.stdout || '') + (built.stderr || ''));
  if (built.status !== 0) return;
  await writeFiles(session, title, uid, backup, manifest);
}

async function main() {
  console.log('ns2-savekit - guided save data access for Switch 2');
  console.log(NOTICE + '\n');
  const explicit = process.argv[2];
  let session = explicit ? path.resolve(explicit) : await pickSession();
  if (!session) return;
  console.log('session: ' + session);

  for (;;) {
    const action = await choose('What do you want to do?', [
      {label: 'List installed titles', value: 'titles'},
      {label: 'List files in a title save (read-only)', value: 'list'},
      {label: 'Work on one title (backup, write, delete)', value: 'work'},
      {label: 'Quit', value: 'quit'},
    ]);
    if (closed || !action || action.value === 'quit') break;
    if (action.value === 'titles') {
      const rows = await titleRows(session);
      heading(rows.length + ' installed applications  (✔ = write-allowed)');
      for (const row of rows) console.log('  ' + row.label);
      continue;
    }
    if (action.value === 'list') {
      const title = await pickTitle(session);
      if (!title) continue;
      const uid = await pickUid(session, title);
      if (!uid) continue;
      run('save-pull-root.cjs', [session, title, '.', uid, '--list-only'], {stdio: 'inherit'});
      continue;
    }
    const title = await pickTitle(session);
    if (!title) continue;
    const uid = await pickUid(session, title);
    if (!uid) continue;

    let backup = null;
    for (;;) {
      const task = await choose(`Title ${title}`, [
        {label: backup ? `Back up again (current: ${path.basename(backup)})` : 'Back up this save (needed before any write)', value: 'backup'},
        {label: 'Write files from a manifest', value: 'write'},
        {label: 'Install the untethered launcher (Artemis)', value: 'launcher'},
        {label: 'Install the Seedsow Lua Editor save', value: 'editor'},
        {label: 'Delete a file', value: 'delete'},
        {label: 'Back to the main menu', value: 'back'},
      ]);
      if (!task || task.value === 'back') break;
      if (task.value === 'backup') {
        const dir = await doBackup(session, title, uid);
        if (dir) backup = dir;
      } else if (task.value === 'write') {
        await writeManifest(session, title, uid, backup);
      } else if (task.value === 'launcher') {
        await installLauncher(session, title, uid, backup);
      } else if (task.value === 'editor') {
        await installEditor(session, title, uid, backup);
      } else if (task.value === 'delete') {
        await doDelete(session, title, uid);
      }
    }
  }
  rl.close();
  console.log('\ndone. Keep SmileBASIC open while a session is held.');
}

main().catch(error => {
  rl.close();
  console.error('FAILED: ' + error.message);
  process.exitCode = 1;
});
