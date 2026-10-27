#!/usr/bin/env node
// Pull one save archive per session, for every installed application.
//
//   node pull-all.cjs <run-directory> <output-directory> [uid-hex] [--cache]
//
// Enumeration uses ns: (the installed-application list) because fs:srv's
// save-data info reader is refused in this context: commands 60, 61 and 68 all
// answer 0x320002 on every save-data space, while 62 (cache storage) works. See
// tools/probe-info-reader.cjs for that evidence.
//
// Saving one archive per boot is deliberate: opening a save filesystem is the
// operation that crashes the host often enough that a single boot is the safe
// unit. Progress lives in <output-directory>/progress.json, so a restart
// continues with the next application instead of starting over.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const titles = require('./lib/titles.cjs');

const TOOLS = __dirname;

function runTool(script, args) {
  return spawnSync(process.execPath, [path.join(TOOLS, script), ...args], {encoding: 'utf8'});
}

function installedApplications(run) {
  const result = runTool('list-apps.cjs', [run]);
  const ids = [...(result.stdout || '').matchAll(/0x([0-9a-f]{16})/g)].map(m => m[1]);
  return [...new Set(ids)];
}

function accountUids(run) {
  const result = runTool('save-pull-root.cjs', [run, '0000000000000000', '.', '--list-uids']);
  return [...new Set((result.stdout || '').split('\n').map(s => s.trim())
    .filter(s => /^[0-9a-f]{32}$/i.test(s)))];
}

async function main() {
  let argv = process.argv.slice(2);
  const wantCache = argv.includes('--cache');
  argv = argv.filter(a => a !== '--cache');
  const [runDirectory, outputDirectory, forcedUid] = argv;
  if (!runDirectory || !outputDirectory) {
    console.error('usage: node pull-all.cjs <run-directory> <output-directory> [uid-hex] [--cache]');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const output = path.resolve(outputDirectory);
  await fsp.mkdir(output, {recursive: true});
  const progressFile = path.join(output, 'progress.json');
  let progress = {done: [], absent: []};
  try { progress = JSON.parse(await fsp.readFile(progressFile, 'utf8')); } catch { /* first run */ }
  progress.done ||= [];
  progress.absent ||= [];

  const apps = installedApplications(run);
  if (apps.length === 0) throw Error('no installed applications listed - is the session live?');
  const uids = forcedUid ? [forcedUid] : accountUids(run);
  await titles.refresh();
  console.log(`${apps.length} installed applications, ${uids.length} account uid(s)`);

  const pending = apps.filter(id => !progress.done.includes(id) && !progress.absent.includes(id));
  if (pending.length === 0) {
    console.log('every application has been handled; nothing left to pull');
    return;
  }
  const appId = pending[0];
  const folder = path.join(output, titles.slug(appId));
  console.log(`next: ${titles.label(appId)} -> ${folder}`);
  console.log('one archive per session; progress advances only on success');

  let pulled = false;
  for (const uid of (uids.length ? uids : [''])) {
    const args = [run, appId, folder];
    if (uid) args.push(uid);
    const result = spawnSync(process.execPath, [path.join(TOOLS, 'save-pull-root.cjs'), ...args],
      {stdio: 'inherit'});
    if (result.status === 0) { pulled = true; break; }
  }
  if (pulled) {
    progress.done.push(appId);
    console.log(`pulled ${progress.done.length}/${apps.length}`);
  } else {
    progress.absent.push(appId);
    console.log('no save data for this application (0x7d402 for every account/space/type)');
  }
  await fsp.writeFile(progressFile, JSON.stringify(progress, null, 2) + '\n');
  const left = apps.length - progress.done.length - progress.absent.length;
  console.log(left === 0
    ? 'done: restart the console once more if --cache is still to collect'
    : `restart the console, then run again for the next of ${left} remaining`);
  if (wantCache) {
    console.log('--cache: cache storage is enumerable (fs:srv cmd 62) but not yet pullable;');
    console.log('   run tools/probe-info-reader.cjs to see the one archive it reports.');
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
