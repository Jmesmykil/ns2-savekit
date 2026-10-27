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

function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";
}
// Print the exact command an action runs, so it can be copied and re-run by hand
// (and so nothing happens that the user cannot see).
function echoCommand(command) {
  console.log('\n$ ' + command);
}
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
  const home = process.env.HOME || '';
  const bases = [
    process.env.NS2_RUNS,                                  // explicit override
    path.join(process.cwd(), 'runs'),                       // ./runs
    path.join(REPO, '..', 'ns2jb-rpc', 'runs'),             // sibling checkout
    path.join(REPO, '..', 'ns2jb', 'runs'),                 // sibling upstream
    path.join(home, 'ns2jb-rpc', 'runs'),
    path.join(home, 'ns2jb', 'runs'),
  ].filter(Boolean);
  const candidates = [];
  for (const base of bases) {
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

const UID_CACHE = path.join(__dirname, '..', 'config', 'uids.json');
function uidCache() {
  try { return JSON.parse(fs.readFileSync(UID_CACHE, 'utf8')); } catch { return {}; }
}
function rememberUid(title, uid) {
  const map = uidCache();
  map[title.toLowerCase()] = uid;
  try {
    fs.mkdirSync(path.dirname(UID_CACHE), {recursive: true});
    fs.writeFileSync(UID_CACHE, JSON.stringify(map, null, 2) + '\n');
  } catch { /* cache is a convenience */ }
}

async function pickUid(session, title) {
  const cached = uidCache()[title.toLowerCase()];
  if (cached) {
    console.log('account uid: ' + cached + '  (remembered; config/uids.json)');
    return cached;
  }
  const result = run('find-save-uid.cjs', [session, title]);
  const uids = [...result.out.matchAll(/\b([0-9a-f]{32})\b/g)].map(match => match[1]);
  const unique = [...new Set(uids)];
  if (unique.length === 1) {
    console.log('account uid: ' + unique[0]);
    rememberUid(title, unique[0]);
    return unique[0];
  }
  if (unique.length === 0) {
    console.log('Could not enumerate an account uid for this title.');
    console.log('Enter the 32-hex uid once; it is remembered per title afterwards.');
    const typed = await askDefault('account uid (32 hex chars)');
    if (!typed) {
      console.log('no uid given - back to the menu');
      return null;
    }
    rememberUid(title, typed);
    return typed;
  }
  const chosen = await choose('Which account?', unique.map(uid => ({label: uid, value: uid})));
  return chosen ? chosen.value : null;
}

async function doBackup(session, title, uid) {
  const suggested = path.join(REPO, 'saves', title);
  const dir = await askDefault('Directory for the backup', suggested);
  if (!dir) return null;
  const pullArgs = [session, title, dir, uid];
  echoCommand('node tools/save-pull-root.cjs ' + pullArgs.map(quote).join(' '));
  const result = run('save-pull-root.cjs', pullArgs, {stdio: 'inherit'});
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
  const writeArgs = [session, title, uid, backup, manifest];
  echoCommand('node tools/save-write-stage.cjs ' + writeArgs.map(quote).join(' '));
  const result = run('save-write-stage.cjs', writeArgs, {stdio: 'inherit'});
  console.log(result.ok ? '\ncommitted' : '\nwrite failed - see the message above');
  saveOpDone();
  if (result.ok) {
    console.log('\nNext: restart the console, then choose this title and 7 (verify) as the');
    console.log('FIRST save operation of that boot - verify is itself a save operation.');
  }
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
  const deleteArgs = [session, title, uid, target];
  echoCommand('node tools/save-delete-root.cjs ' + deleteArgs.map(quote).join(' '));
  const result = run('save-delete-root.cjs', deleteArgs, {stdio: 'inherit'});
  console.log(result.ok ? '\ndeleted' : '\ndelete failed');
  saveOpDone();
}

async function installLauncher(session, title, uid, backup) {
  if (!backup) {
    console.log('A backup is required first (it is the base the launcher is built from).');
    return;
  }
  const editor = fs.existsSync(path.join(backup, 'ssedit1.lua')) ||
                 fs.existsSync(path.join(backup, 'sed01.asb'));
  if (!editor) {
    console.log('note: the Seedsow Lua Editor is not in this save. The launcher still works');
    console.log('(the stub falls back to ns2jb.lua), but for on-console authoring install the');
    console.log('editor FIRST (option 5), then this - its install rewrites slot 4.');
  }
  const out = path.join(REPO, 'staging', path.basename(backup));
  echoCommand('tools/build-untethered.sh ' + quote(backup) + ' ' + quote(out));
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
  if (fs.existsSync(path.join(backup, 'ns2jb.asb'))) {
    console.log('note: payload files are already installed. The editor install rewrites slot 4,');
    console.log('so the stub would then run the editor example - re-run the payload install');
    console.log('(option 4) after this to claim slot 4 again.');
  }
  const source = await askDefault('Directory with the editor save (fetch it first)', '/tmp/seed');
  const manifest = path.join(REPO, 'staging', 'editor-manifest.json');
  fs.mkdirSync(path.dirname(manifest), {recursive: true});
  const built = spawnSync('python3', [path.join(TOOLS, 'build-editor-manifest.py'), source, backup, manifest], {encoding: 'utf8'});
  console.log((built.stdout || '') + (built.stderr || ''));
  if (built.status !== 0) return;
  await writeFiles(session, title, uid, backup, manifest);
}

async function verifyAgainst(session, title, uid, backup) {
  if (opsThisSession > 0) {
    console.log('\nVerify is a save operation (it re-opens the save read-only to compare).');
    console.log('This boot has already performed ' + opsThisSession + '.');
    console.log('Restart the console and run verify as the FIRST operation of the next boot.');
    if (!(await confirm('Try anyway?'))) return;
  }
  const staged = await askDefault('Directory holding the files just written',
    path.join(REPO, 'staging', path.basename(backup || title)));
  if (!fs.existsSync(staged)) {
    console.log('no such directory: ' + staged);
    return;
  }
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'verify-'));
  const pullArgs = [session, title, temp, uid];
  echoCommand('node tools/save-pull-root.cjs ' + pullArgs.map(quote).join(' '));
  const pulled = run('save-pull-root.cjs', pullArgs, {stdio: 'inherit'});
  if (!pulled.ok) {
    console.log('\npull failed - one save operation per boot; restart and verify as the first one.');
    return;
  }
  saveOpDone();
  let ok = 0, bad = 0;
  for (const name of fs.readdirSync(staged)) {
    const local = path.join(staged, name);
    if (!fs.statSync(local).isFile()) continue;
    const remote = path.join(temp, name);
    if (!fs.existsSync(remote)) { console.log('  missing in save: ' + name); bad++; continue; }
    const same = fs.readFileSync(local).equals(fs.readFileSync(remote));
    console.log('  ' + (same ? 'ok      ' : 'DIFFERS ') + name);
    same ? ok++ : bad++;
  }
  console.log(`\nverify: ${ok} matching, ${bad} differing or missing`);
}

async function replaceFromDirectory(session, title, uid, backup) {
  if (!backup) {
    console.log('Back this save up first (option 2): the write checks live bytes against it.');
    return;
  }
  const source = await askDefault('Directory holding the files to install (e.g. a save backup or /tmp/seed)');
  if (!source || !fs.existsSync(source)) {
    console.log('no such directory: ' + source);
    return;
  }
  const manifest = path.join(REPO, 'staging', path.basename(source) + '-manifest.json');
  fs.mkdirSync(path.dirname(manifest), {recursive: true});
  echoCommand('python3 tools/build-editor-manifest.py ' + quote(source) + ' ' + quote(backup) +
    ' ' + quote(manifest));
  const built = spawnSync('python3',
    [path.join(TOOLS, 'build-editor-manifest.py'), source, backup, manifest], {encoding: 'utf8'});
  console.log((built.stdout || '') + (built.stderr || ''));
  if (built.status !== 0) return;
  await writeFiles(session, title, uid, backup, manifest);
}

async function titleLoop(session, title, uid) {
  let backup = null;
  for (;;) {
    const task = await choose(titles.label(title), [
      {label: 'List files in this save (read-only)      [save op]', value: 'list'},
      {label: 'Save: back this save up                     [save op]', value: 'backup'},
      {label: 'Replace: write files from a directory        [save op]', value: 'replace'},
      {label: 'Install payload files (Artemis launcher)     [save op]', value: 'launcher'},
      {label: 'Install the Seedsow Lua Editor save          [save op]', value: 'editor'},
      {label: 'Delete a file (optional)                     [save op]', value: 'delete'},
      {label: 'Verify: compare the save with what we wrote  [save op]', value: 'verify'},
      {label: 'Back to the title list', value: 'back'},
    ]);
    if (closed || !task || task.value === 'back') return;
    if (task.value === 'list') {
      const listArgs = [session, title, '.', uid, '--list-only'];
      echoCommand('node tools/save-pull-root.cjs ' + listArgs.map(quote).join(' '));
      const listed = run('save-pull-root.cjs', listArgs, {stdio: 'inherit'});
      if (!listed.ok) {
        console.log('\nlisting failed - if this is not the first save operation in this boot,');
        console.log('restart the console (a second one crashes the host with 2162-0002).');
      } else {
        saveOpDone();
      }
    } else if (task.value === 'backup') {
      const dir = await doBackup(session, title, uid);
      if (dir) backup = dir;
    } else if (task.value === 'replace') {
      await replaceFromDirectory(session, title, uid, backup);
    } else if (task.value === 'launcher') {
      await installLauncher(session, title, uid, backup);
    } else if (task.value === 'editor') {
      await installEditor(session, title, uid, backup);
    } else if (task.value === 'delete') {
      await doDelete(session, title, uid);
    } else if (task.value === 'verify') {
      await verifyAgainst(session, title, uid, backup);
    }
  }
}

async function main() {
  console.log('ns2-savekit - guided save data access for Switch 2');
  console.log(NOTICE + '\n');
  const explicit = process.argv[2];
  let session = explicit ? path.resolve(explicit) : await pickSession();
  if (!session) return;
  console.log('session: ' + session + '\n');

  for (;;) {
    const rows = await titleRows(session);
    if (rows.length === 0) {
      console.log('no titles listed - is the session still live?');
      console.log('check with: node rpc.cjs ' + session + ' status');
      break;
    }
    heading(rows.length + ' installed applications  (✔ = write-allowed)');
    rows.forEach((row, index) => console.log('  [' + (index + 1) + '] ' + row.label));
    const picked = await ask('\nNumber 1-' + rows.length + ' (blank = quit): ');
    if (closed || picked === '') break;
    const index = Number(picked) - 1;
    if (!Number.isInteger(index) || !rows[index]) {
      console.log('  not a listed number');
      continue;
    }
    const title = rows[index].id;
    const uid = await pickUid(session, title);
    if (!uid) continue;
    await titleLoop(session, title, uid);
  }
  rl.close();
  console.log('\ndone. Keep SmileBASIC open while a session is held.');
}

main().catch(error => {
  rl.close();
  console.error('FAILED: ' + error.message);
  process.exitCode = 1;
});
