#!/usr/bin/env node
'use strict';
// Validate the prepared package before importing code or opening a listener.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function regular(file,root){
  if(!file.startsWith(root+path.sep))throw Error('File outside package');
  let current=file;
  while(current!==root){const s=fs.lstatSync(current);if(s.isSymbolicLink())throw Error('Package symlink refused');current=path.dirname(current);}
  if(!fs.lstatSync(file).isFile())throw Error('Regular package file required');
}
async function main(args=process.argv.slice(2)){
  const [attempt,pin]=args,root=path.resolve(__dirname,'..');
  if(args.length!==2||!attempt||!/^[a-f0-9]{64}$/.test(pin||''))throw Error('usage: node live/start.cjs ABSOLUTE_ATTEMPT PACKAGE_SHA256');
  const lockFile=path.join(root,'package-lock.json');regular(lockFile,root);
  const bytes=fs.readFileSync(lockFile);
  if(hash(bytes)!==pin)throw Error('Prepared package seal differs');
  const lock=JSON.parse(bytes);
  if(lock.schema!==1||!Array.isArray(lock.files)||lock.files.length<90||lock.stageDeadlineMs!==600000)throw Error('Package manifest shape differs');
  const seen=new Set();
  for(const entry of lock.files){
    if(typeof entry.path!=='string'||path.isAbsolute(entry.path)||entry.path.split('/').some(x=>!x||x==='.'||x==='..')||seen.has(entry.path))throw Error('Unsafe package path');
    seen.add(entry.path);const file=path.join(root,entry.path);regular(file,root);
    if(hash(fs.readFileSync(file))!==entry.sha256)throw Error('Prepared source changed: '+entry.path);
  }
  const launcher=require('./live-launcher-established.cjs');
  const launcherPin=lock.files.find(x=>x.path==='live/live-launcher-established.cjs')?.sha256;
  const bridgePin=lock.files.find(x=>x.path==='live/scoped-bridge.cjs')?.sha256;
  launcher.prepareBinding({attemptDirectory:path.resolve(attempt),expectedLauncherSha256:launcherPin,expectedScopedBridgeSha256:bridgePin});
  await launcher.serveAttempt({attemptDirectory:path.resolve(attempt),allowConsoleListener:true});
}
module.exports={main};
if(require.main===module)main().catch(error=>{process.stderr.write('Host refused: '+String(error.message).slice(0,220)+'\n');process.exitCode=1;});
