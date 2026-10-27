#!/usr/bin/env node
// Find the account uid of the app's mounted save by scanning memory around the
// mount objects for the application's program id (FsSaveDataAttribute layout).
//
//   node find-save-uid.cjs <run-directory> [program-id]
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(120000, () => socket.destroy(new Error('timeout')));
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

async function main() {
  const [runDirectory, programText = '0100c9100b06a000'] = process.argv.slice(2);
  const engine = path.resolve(runDirectory, 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  let mounted = {};
  try {
    mounted = require(path.join(engine, 'app/mounted-save.cjs'));
  } catch (error) {
    // Upstream builds have no mounted-save inspection module (or it throws on
    // import outside a live boot); both mean the uid scan is unavailable.
    mounted = {importError: error.message};
  }
  if (typeof mounted.inspectMountedFilesystem !== 'function') {
    console.error('This ns2jb build has no mounted-save inspection.');
    console.error('The uid scan needs the patched app/mounted-save.cjs (see');
    console.error('docs/PATCHED-ENGINE.md). Pass the account uid by hand instead.');
    process.exit(0);
  }

  const {Session} = require(path.join(engine, 'app/session.cjs'));
  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('uid-scan-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  try {
    const mount = await mounted.inspectMountedFilesystem(s, 'save');
    console.log('mount', mount);
    const programId = BigInt(/^0x/i.test(programText) ? programText : '0x' + programText);
    const needle = Buffer.alloc(8);
    needle.writeBigUInt64LE(programId);
    const regions = [
      ['service', mount.serviceAddress, 0x4000],
      ['implementation', mount.implementationAddress, 0x4000],
      ['manager', mount.manager, 0x4000],
      ['accessor', mount.accessor, 0x4000],
    ];
    for (const [label, address, length] of regions) {
      const start = Math.max(0, Number(address) - 0x800);
      const bytes = await s.read(start, length).catch(error => {
        console.log(`  ${label}: read failed (${error.message})`);
        return null;
      });
      if (!bytes) continue;
      let at = bytes.indexOf(needle);
      let hits = 0;
      while (at >= 0 && hits < 8) {
        const window = bytes.subarray(at, at + 0x60);
        console.log(`  ${label} +0x${(start - Number(address) + at).toString(16)}: ${window.toString('hex')}`);
        at = bytes.indexOf(needle, at + 1);
        hits += 1;
      }
      if (!hits) console.log(`  ${label}: program id not found in window`);
    }
  } finally {
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
