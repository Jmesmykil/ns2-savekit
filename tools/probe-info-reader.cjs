#!/usr/bin/env node
// Find the fsp-srv command that enumerates save-data archives on this build.
//
// The save-info reader is the missing piece for a whole-space dump: once it
// opens, ReadSaveDataInfo returns one entry per archive (program id, space, type,
// uid, size) and each can be pulled like any other save.
//
//   node probe-info-reader.cjs <run-directory>
//
// Read-only: it opens candidate readers and closes them. No save filesystem is
// opened, nothing is written, no commit is issued.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const SPACES = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'SdUser'};
const TYPES = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary', 5: 'Cache'};

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

async function main() {
  const [runDirectory] = process.argv.slice(2);
  if (!runDirectory) {
    console.error('usage: node probe-info-reader.cjs <run-directory>');
    process.exit(2);
  }
  const engine = path.join(path.resolve(runDirectory), 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fs.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  if (rootProof.session !== current.session || rootProof.pid !== 1 || !rootProof.rootHandle) {
    throw new Error('The run has no promoted fsp-srv root (expected pid 1)');
  }
  const root = rootProof.rootHandle;
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  await request(current.socketPath, {command: 'root-native-info'});

  const s = new Session('probe-info-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  try {
    const fsp = await s.openService('fsp-srv');
    // 1-byte space input, and the 0x40-byte SaveDataInfoFilter, tried against a
    // range of command ids because the numbering differs between fs versions.
    const oneByte = Buffer.from([1]);                       // SaveDataSpaceId_User
    const filter = Buffer.alloc(0x40);
    filter[8] = 1;                                          // space = User
    filter[9] = 1;                                          // type  = Account
    const probes = [
      ['1B', oneByte],
      ['40', filter],
    ];
    for (let command = 55; command <= 64; command++) {
      for (const [label, payload] of probes) {
        const reply = await s.ipc('info reader ' + command + '/' + label, fsp, command, payload)
          .catch(error => ({result: -1, error, moves: []}));
        const result = Number(reply.canonicalResult ?? reply.result ?? -1) & 0x3fffff;
        const moves = reply.moves ? reply.moves.length : 0;
        if (result === 0 && moves > 0) {
          console.log(`command ${command} (${label} input): OK, ${moves} handle(s)`);
          const reader = domain.oneHandle(reply);
          const buffer = s.base + 0x8000;
          const stride = 0x60;
          const slots = 32;
          await s.write(buffer, Buffer.alloc(stride * slots));
          const read = await s.ipc('read save info', reader, 0, Buffer.alloc(8),
            {receive: [{address: buffer, size: stride * slots, mode: 0}]}).catch(error => ({result: -1, error}));
          const readResult = Number(read.canonicalResult ?? read.result ?? -1) & 0x3fffff;
          console.log(`  read -> ${code(readResult)}`);
          if (readResult === 0) {
            const bytes = await s.read(buffer, stride * slots);
            for (let i = 0; i < slots; i++) {
              const entry = bytes.subarray(i * stride, (i + 1) * stride);
              const id = entry.readBigUInt64LE(0);
              const appId = entry.readBigUInt64LE(0x28);
              if (!id && !appId) continue;
              const uid = entry.subarray(0x10, 0x20).toString('hex');
              const size = entry.readBigUInt64LE(0x30);
              console.log(`    id=${id} space=${SPACES[entry[8]] ?? entry[8]} ` +
                `type=${TYPES[entry[9]] ?? entry[9]} uid=${uid} ` +
                `app=0x${appId.toString(16)} size=${size}`);
            }
          }
          await s.close(reader);
        } else if (result !== 0x2ee002) {
          // Anything other than "invalid argument" is interesting: it means the
          // command exists but wants something different.
          console.log(`command ${command} (${label} input): ${code(result)} moves=${moves}`);
        }
      }
    }
    console.log('probe finished; command ids that returned OK above are the reader.');
  } finally {
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
