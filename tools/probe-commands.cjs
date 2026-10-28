#!/usr/bin/env node
// What does fsp-srv actually implement on this build?
//
//   node probe-commands.cjs <run-directory> [first] [last]
//
// Sends each command id with an empty input and records the result code, so ids
// that exist can be told apart from ids that do not. Everything is sent WITHOUT a
// valid SaveDataAttribute, so a destructive command cannot match a real save: the
// worst case is the same "not found" answer a wrong uid gets.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const code = v => '0x' + (Number(v) & 0x3fffff).toString(16);

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(30000, () => socket.destroy(new Error('timeout')));
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
  const [runDirectory, firstArg, lastArg] = process.argv.slice(2);
  if (!runDirectory) {
    console.error('usage: node probe-commands.cjs <run-directory> [first] [last]');
    process.exit(2);
  }
  const first = Number(firstArg ?? 0);
  const last = Number(lastArg ?? 120);
  const engine = path.join(path.resolve(runDirectory), 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const {Session, u64} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  await request(current.socketPath, {command: 'root-native-info'});

  const s = new Session('probe-cmds-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  const byResult = new Map();
  try {
    const fsp = await s.openService('fsp-srv');
    // The pid flag matters: without it FS does not bind the process and every
    // later command fails at transport rather than returning a result code.
    const init = await s.ipc('SetCurrentProcess', fsp, 1, u64(0), {pid: true});
    console.log('SetCurrentProcess ->', '0x' + (Number(init.canonicalResult ?? init.result) & 0x3fffff).toString(16));
    for (let command = first; command <= last; command++) {
      let result, moves = 0, copies = 0;
      try {
        // pid:true on every message, the way domain.send does it: once a process is
        // bound, FS rejects messages that do not carry the pid.
        const reply = await s.ipc('cmd ' + command, fsp, command, Buffer.alloc(0), {pid: true});
        result = Number(reply.canonicalResult ?? reply.result) & 0x3fffff;
        moves = reply.moves.length;
        copies = reply.copies.length;
        for (const handle of [...reply.moves, ...reply.copies]) await s.close(handle).catch(() => {});
      } catch (error) {
        // A refused command often comes back as a transport error, not a result
        // code; keep the code so those ids stay distinguishable from silence.
        const transport = /transport 0x([0-9a-f]+)/i.exec(error.message || '');
        result = transport ? 'xport ' + transport[1] : 'threw';
      }
      const key = String(result);
      if (!byResult.has(key)) byResult.set(key, []);
      byResult.get(key).push(command + (moves || copies ? `(+${moves}m/${copies}c)` : ''));
    }
  } finally {
    await s.cleanup().catch(() => {});
  }
  for (const [result, commands] of [...byResult.entries()].sort()) {
    console.log(`${result.padEnd(8)} ${commands.join(' ')}`);
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
