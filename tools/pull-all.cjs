#!/usr/bin/env node
// Pull every save archive in a save-data space, one session at a time.
//
//   node pull-all.cjs <run-directory> <output-directory> [uid-hex] [--space N]
//
// Enumeration uses fs:srv's save-info reader as documented on switchbrew
// (cmd 61 = OpenSaveDataInfoReaderBySaveDataSpaceId, input u8 space; reader cmd 0
// = ReadSaveDataInfo, output buffer only, returns a u64 count; SaveDataInfo is
// 0x38 bytes). Nothing is written to the console: this only opens readers and
// pulls each archive read-only.
//
// Each run pulls ONE archive, because opening a save filesystem crashes the host
// often enough that a single boot is the safe unit. Progress is recorded in
// <output-directory>/progress.json, so re-running after a restart continues with
// the next archive.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const SPACES = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'SdUser'};
const TYPES = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary', 5: 'Cache'};
const ATTRIBUTE_SPACE = {1: 1, 0: 0, 2: 2, 3: 1, 4: 1};   // space -> OpenSaveDataFileSystem space

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(60000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => { input += part; });
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

const code = value => '0x' + (Number(value) & 0x3fffff).toString(16);

async function enumerate(s, fsp, domain, space) {
  const payload = Buffer.alloc(4);
  payload[0] = space;
  let opened = await s.ipc('OpenSaveDataInfoReaderBySaveDataSpaceId', fsp, 61, payload);
  let command = 61;
  if (opened.result) {
    opened = await s.ipc('OpenSaveDataInfoReader', fsp, 60, Buffer.alloc(0));
    command = 60;
  }
  if (opened.result || !opened.moves.length) {
    throw Error('save-info reader unavailable: ' + code(opened.result) +
      ' (run tools/probe-info-reader.cjs)');
  }
  console.log('reader opened with cmd ' + command);
  const reader = domain.oneHandle(opened);
  const entries = [];
  const stride = 0x38, slots = 64;
  const buffer = s.base + 0x8000;
  for (;;) {
    await s.write(buffer, Buffer.alloc(stride * slots));
    const reply = await s.ipc('ReadSaveDataInfo', reader, 0, Buffer.alloc(0),
      {receive: [{address: buffer, size: stride * slots, mode: 0}]});
    if (reply.result) throw Error('ReadSaveDataInfo failed: ' + code(reply.result));
    const count = reply.data && reply.data.length >= 8 ? Number(reply.data.readBigUInt64LE()) : 0;
    if (!count) break;
    const bytes = await s.read(buffer, stride * Math.min(count, slots));
    for (let i = 0; i < Math.min(count, slots); i++) {
      const entry = bytes.subarray(i * stride, (i + 1) * stride);
      const appId = entry.readBigUInt64LE(0x28);
      if (!appId) continue;
      entries.push({
        id: entry.readBigUInt64LE(0).toString(),
        space: entry[8], type: entry[9],
        uid: entry.subarray(0x10, 0x20).toString('hex'),
        appId: appId.toString(16).padStart(16, '0'),
        size: entry.readBigUInt64LE(0x30).toString(),
      });
    }
    if (count < slots) break;
  }
  await s.close(reader).catch(() => {});
  return entries;
}

async function main() {
  let argv = process.argv.slice(2);
  const spaceIndex = argv.indexOf('--space');
  const space = spaceIndex >= 0 ? Number(argv[spaceIndex + 1]) : 1;
  if (spaceIndex >= 0) argv.splice(spaceIndex, 2);
  const [runDirectory, outputDirectory, forcedUid] = argv;
  if (!runDirectory || !outputDirectory) {
    console.error('usage: node pull-all.cjs <run-directory> <output-directory> [uid-hex] [--space N]');
    process.exit(2);
  }
  const output = path.resolve(outputDirectory);
  await fsp.mkdir(output, {recursive: true});
  const progressFile = path.join(output, 'progress.json');
  let progress = {done: [], entries: null};
  try { progress = JSON.parse(await fsp.readFile(progressFile, 'utf8')); } catch { /* first run */ }

  const engine = path.join(path.resolve(runDirectory), 'switch2');
  const current = JSON.parse(await fsp.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fsp.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  if (rootProof.session !== current.session || rootProof.pid !== 1 || !rootProof.rootHandle) {
    throw Error('The run has no promoted fsp-srv root (expected pid 1)');
  }
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  await request(current.socketPath, {command: 'root-native-info'});

  const s = new Session('pull-all-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  try {
    const fspService = await s.openService('fsp-srv');
    if (!progress.entries) {
      progress.entries = await enumerate(s, fspService, domain, space);
      await fsp.writeFile(progressFile, JSON.stringify(progress, null, 2) + '\n');
      console.log('enumerated ' + progress.entries.length + ' archives in ' +
        (SPACES[space] ?? space) + ' space');
    } else {
      console.log('using ' + progress.entries.length + ' cached entries from progress.json');
    }
  } finally {
    await s.cleanup().catch(() => {});
  }

  const pending = progress.entries.filter(entry =>
    !progress.done.includes(entry.appId + ':' + entry.uid));
  if (pending.length === 0) {
    console.log('all archives already pulled into ' + output);
    return;
  }
  const next = pending[0];
  const target = path.join(output, next.appId + (next.uid.startsWith('0'.repeat(32)) ? '' : '-' + next.uid));
  console.log('next: 0x' + next.appId + ' space=' + (SPACES[next.space] ?? next.space) +
    ' type=' + (TYPES[next.type] ?? next.type) + ' uid=' + next.uid +
    ' size=' + next.size + ' -> ' + target);
  console.log('pulling ONE archive this session, then restart the console and re-run.');
  const args = [path.join(__dirname, 'save-pull-root.cjs'), runDirectory, next.appId, target];
  if (!next.uid.startsWith('0'.repeat(32))) args.push(next.uid.startsWith('0'.repeat(16)) ? next.uid : forcedUid || next.uid);
  const pulled = spawnSync(process.execPath, args, {stdio: 'inherit'});
  if (pulled.status !== 0) {
    console.log('pull failed; progress not advanced (the save may be absent for this account)');
    return;
  }
  progress.done.push(next.appId + ':' + next.uid);
  await fsp.writeFile(progressFile, JSON.stringify(progress, null, 2) + '\n');
  console.log('pulled ' + (progress.done.length + '/' + progress.entries.length) +
    '; restart the console and run again for the next archive');
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
