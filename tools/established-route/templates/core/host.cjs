#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const {pairingCode, listen} = require('./sources/connection.cjs');
const {NativeClient} = require('./sources/native.cjs');
const {qualify} = require('./sources/qualify.cjs');

const ROOT = __dirname;
const HOST = '__HOST__';
const PORT = __PORT__;
const PAIRING_MS = 9 * 60 * 1000;
const SSH_CONFIG='__SSH_CONFIG__';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
function exclusive(file, value) {
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,json(value));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function rejectRecovery(env = process.env) {
  if (Object.keys(env).some(k => k.startsWith('NS2_')))
    throw Error('Inherited NS2_* runtime/recovery environment is not accepted');
}
function packagePins(root = ROOT) {
  const owner = JSON.parse(fs.readFileSync(path.join(root,'ownership.json')));
  for (const record of owner.sources) {
    if (sha(fs.readFileSync(path.join(root,record.copy))) !== record.sha256)
      throw Error('Pinned source changed: ' + record.copy);
  }
  const names = ['host.cjs','phase.py','remote-phase.py','remote-preflight.py','ownership.json','route-config.private.json', ...owner.sources.map(x=>x.copy)].sort();
  const entries = names.map(name=>[name,sha(fs.readFileSync(path.join(root,name)))]);
  return {entries,digest:sha(JSON.stringify(entries))};
}
function validatePreflight(receipt, root=ROOT, now=Date.now()) {
  const probe=typeof receipt==='string'?JSON.parse(fs.readFileSync(receipt)):receipt;
  const config=fs.readFileSync(SSH_CONFIG);
  const d=probe.observation||{},hw=d.hardware||{},trust=probe.trustedSsh||{};
  if(probe.schema!==1||probe.ready!==true||probe.readOnly!==true||probe.phaseReserved!==false||probe.sudoRequested!==true||
     probe.sourceDigest!==packagePins(root).digest||!Number.isSafeInteger(probe.completedUnixMs)||now-probe.completedUnixMs<0||now-probe.completedUnixMs>120000||
     trust.configPath!==SSH_CONFIG||trust.configSha256!==sha(config)||trust.hostKeyAlias!=='__SSH_HOST_KEY_ALIAS__'||trust.host!=='__SSH_ALIAS__'||!trust.hostnameOverride||
     d.effectiveUid!==0||d.openedHID!==false||d.openedLock!==false||d.reservedPhase!==false||
     d.encoderSha256!=='a0a0e5376586367cac4875038e969515f4922e1f07fb63b87e94a07cdfca9f8c'||hw.controllers!==1||hw.state!=='configured'||hw.speed!=='full-speed'||hw.serial!=='__USB_SERIAL__')
    throw Error('A fresh matching privileged read-only preflight receipt is required before preparation');
  for(const [name,kind]of[['receipts','isDirectory'],['lock','isRegular'],['hid','isCharacter']]) {
    const m=d.paths?.[name]||{};
    if(m.exists!==true||m[kind]!==true||m.isSymlink!==false||m.readable!==true||m.writable!==true||(name==='receipts'&&m.searchable!==true))
      throw Error('Preflight input path access does not qualify');
  }
  return probe;
}
function prepare(root = ROOT, now = Date.now(), preflightReceipt) {
  rejectRecovery();
  if(!preflightReceipt)throw Error('Use --prepare --preflight-receipt with a fresh privileged read-only receipt');
  const preflight=validatePreflight(preflightReceipt,root,now);
  const pins = packagePins(root);
  const attempts = path.join(root,'attempts');
  fs.mkdirSync(attempts,{recursive:true,mode:0o700});
  if (fs.lstatSync(attempts).isSymbolicLink()) throw Error('Attempt root must not be a symlink');
  const attempt = 'l02-' + crypto.randomUUID();
  const directory = path.join(attempts,attempt);
  fs.mkdirSync(directory,{mode:0o700});
  fs.mkdirSync(path.join(directory,'trace'),{mode:0o700});
  fs.mkdirSync(path.join(directory,'phases'),{mode:0o700});
  const token = pairingCode();
  const command = `V=START(${[PORT,...HOST.split('.'),...token].join(',')})`;
  const launch = {schema:1,attempt,directory,host:HOST,port:PORT,created:now,
    incarnation:crypto.randomUUID(),controlToken:crypto.randomBytes(32).toString('hex'),
    token,connectCommand:command,pins,
    encoderSha256:'a0a0e5376586367cac4875038e969515f4922e1f07fb63b87e94a07cdfca9f8c',
    nativeQualification:'64-byte owned scratch challenge/restore plus pinned SDK/activity checks',
    filesystemAcquisition:false,preflight:{receiptPath:path.resolve(preflightReceipt),sha256:sha(fs.readFileSync(preflightReceipt)),completedUnixMs:preflight.completedUnixMs}};
  exclusive(path.join(directory,'launch.json'),launch);
  fs.writeFileSync(path.join(directory,'connect.txt'),command+'\n',{flag:'wx',mode:0o600});
  exclusive(path.join(directory,'ownership.json'),{purpose:'single-use-savekit-session',attempt,cleanup:'Preserve until reviewed; no replay'});
  return launch;
}
function loadLaunch(directory, root = ROOT) {
  directory = fs.realpathSync(directory);
  const attempts = fs.realpathSync(path.join(root,'attempts'));
  if (path.dirname(directory) !== attempts) throw Error('Expected a direct child of this package attempts directory');
  const launch = JSON.parse(fs.readFileSync(path.join(directory,'launch.json')));
  if (launch.directory !== directory || path.basename(directory)!==launch.attempt || !/^l02-[0-9a-f-]{36}$/.test(launch.attempt))
    throw Error('Attempt identity differs');
  if (launch.host!==HOST || launch.port!==PORT || launch.pins.digest!==packagePins(root).digest)
    throw Error('Host or source pins differ');
  const command = `V=START(${[PORT,...HOST.split('.'),...launch.token].join(',')})`;
  if (launch.connectCommand!==command || fs.readFileSync(path.join(directory,'connect.txt'),'utf8')!==command+'\n')
    throw Error('Private pairing command differs');
  return launch;
}
function eventWriter(directory) {
  const fd = fs.openSync(path.join(directory,'host-events.jsonl'),'ax',0o600);
  return {emit(type,fields={}) {fs.writeSync(fd,JSON.stringify({type,utc:new Date().toISOString(),monotonicNs:process.hrtime.bigint().toString(),...fields})+'\n');fs.fsyncSync(fd);},
    close(){fs.closeSync(fd);}};
}
function traceConnection(connection, directory, log) {
  let sequence = 0;
  for (const method of ['read','write']) {
    const original = connection[method].bind(connection);
    connection[method] = async function(value) {
      const id = ++sequence;
      log.emit('native-'+method+'-reserved',{id,bytes:method==='read'?value:value.length});
      if (method==='write') {
        const file=`${String(id).padStart(5,'0')}-request.bin`;
        fs.writeFileSync(path.join(directory,'trace',file),value,{flag:'wx',mode:0o600});
        log.emit('native-request-saved',{id,file,sha256:sha(value),bytes:value.length});
      }
      try {
        const reply = await original(value);
        if (method==='read') {
          const file=`${String(id).padStart(5,'0')}-response.bin`;
          fs.writeFileSync(path.join(directory,'trace',file),reply,{flag:'wx',mode:0o600});
          log.emit('native-response-saved',{id,file,sha256:sha(reply),bytes:reply.length});
        } else log.emit('native-write-completed',{id});
        return reply;
      } catch (error) {log.emit('native-'+method+'-uncertain',{id,error:error.message});throw error;}
    };
  }
}
function createController({launch,native,connection,log,setStatus,now=()=>Date.now()}) {
  let busy=false,terminal=false,closed=false;
  const samples = new Set();
  async function fail(error) {
    terminal=true;
    setStatus('TERMINAL_UNCERTAIN',{error:error.message,nativeOwnership:false,replayAllowed:false});
    log.emit('terminal-uncertain',{error:error.message});
    connection.close();
  }
  async function sample(label) {
    if (terminal || closed || connection.error) throw Error('Connection is terminal; no replay');
    if (busy) throw Error('A native operation is already pending');
    if (!['before','after'].includes(label) || samples.has(label) || (label==='after'&&(!samples.has('before')||!fs.existsSync(path.join(launch.directory,'mark-during.json')))))
      throw Error('Invalid or consumed sample checkpoint');
    samples.add(label);busy=true;
    exclusive(path.join(launch.directory,`sample-${label}-reserved.json`),{attempt:launch.attempt,label,unixMs:now(),outcome:'unknown until reply'});
    log.emit('sample-reserved',{label});
    try {
      const started=now();
      const bytes=await native.read(native.addresses.got,8);
      if (bytes.length!==8 || bytes.readBigUInt64LE()!==BigInt(native.addresses.memmove)) throw Error('Fresh GOT response differs');
      const result={attempt:launch.attempt,incarnation:launch.incarnation,label,started,completed:now(),
        bytesHex:bytes.toString('hex'),sha256:sha(bytes),freshConsoleReply:true,sameAcceptedConnection:true,calls:native.calls};
      exclusive(path.join(launch.directory,`sample-${label}.json`),result);
      log.emit('sample-completed',result);setStatus('QUALIFIED',{lastFreshReply:result.completed});
      return result;
    } catch(error){await fail(error);throw error;} finally{busy=false;}
  }
  async function command(request) {
    if(request.command==='status') return {busy,terminal,closed,sampleLabels:[...samples]};
    if(request.command==='sample') return sample(request.label);
    if(request.command==='mark') {
      if(terminal || closed || connection.error || busy || request.label!=='during' || !samples.has('before') || samples.has('after'))
        throw Error('During mark needs an active qualified connection after before sample');
      if(!/^[0-9a-f]{64}$/.test(request.captureSha256||'')) throw Error('Expected during screen capture SHA256');
      const result={attempt:launch.attempt,label:'during',utc:new Date().toISOString(),captureSha256:request.captureSha256,
        connectionDestroyed:!!connection.socket.destroyed,freshConsoleReply:false,meaning:'Passive transport/UI checkpoint; cached status is not a native response'};
      exclusive(path.join(launch.directory,'mark-during.json'),result);log.emit('during-mark',result);return result;
    }
    if(request.command==='stop') {
      if(terminal || closed || busy || connection.error) throw Error('Cannot send stop from an uncertain or busy connection');
      closed=true;busy=true;
      try {await native.stop();setStatus('CLOSED',{nativeOwnership:false,filesystemCleanupClaim:false});log.emit('normal-stop-sent',{filesystemCleanupClaim:false});return {closed:true};}
      catch(error){await fail(error);throw error;}finally{busy=false;}
    }
    throw Error('Only status, fixed samples, during mark and stop are supported');
  }
  return {command,fail,get terminal(){return terminal;},get closed(){return closed;}};
}
async function controlServer(launch,state,controllerRef) {
  const server=net.createServer(socket=>{
    let input='',used=false;
    socket.setTimeout(5000,()=>socket.destroy());
    socket.on('data',chunk=>{
      if(used)return;
      input+=chunk.toString('utf8');
      if(input.length>4096){socket.destroy();return;}
      if(!input.includes('\n'))return;
      used=true;
      (async()=>{
        try {
          const request=JSON.parse(input.trim());
          if(typeof request.token!=='string'||request.token.length!==64||!crypto.timingSafeEqual(Buffer.from(request.token),Buffer.from(launch.controlToken))) throw Error('Control authentication differs');
          if(request.attempt!==launch.attempt || request.incarnation!==launch.incarnation) throw Error('Control attempt identity differs');
          const snapshot={...state(),attempt:launch.attempt,incarnation:launch.incarnation,pid:process.pid,pinsDigest:launch.pins.digest};
          if(request.command==='status') {
            const detail=controllerRef.current?await controllerRef.current.command(request):{};
            socket.end(json({ok:true,...snapshot,...detail,freshConsoleReply:false}));
          } else {
            if(!controllerRef.current)throw Error('Native connection not qualified');
            // Native receives may take 120 seconds while application is suspended.
            socket.setTimeout(125000,()=>socket.destroy());
            const result=await controllerRef.current.command(request);socket.end(json({ok:true,...snapshot,...state(),result}));
          }
        }catch(error){socket.end(json({ok:false,error:error.message}));}
      })().catch(()=>socket.destroy());
    });
    socket.on('error',()=>{});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return server;
}
async function serveAttempt(directory, root=ROOT) {
  rejectRecovery();
  const launch=loadLaunch(directory,root);
  exclusive(path.join(launch.directory,'host-reserved.json'),{attempt:launch.attempt,pid:process.pid,utc:new Date().toISOString()});
  const log=eventWriter(launch.directory);let current={state:'STARTING',nativeOwnership:false};
  function status(state,extra={}) {
    current={...current,...extra,state,updated:Date.now(),attempt:launch.attempt,incarnation:launch.incarnation,pid:process.pid,pinsDigest:launch.pins.digest};
    fs.writeFileSync(path.join(launch.directory,'status.json'),json(current),{mode:0o600});
  }
  const ref={current:null};
  const control=await controlServer(launch,()=>current,ref);
  let connection,finished=false;
  function finish() {if(finished)return;finished=true;control.close();log.close();}
  try {
    status('WAITING',{pairingDeadline:Date.now()+PAIRING_MS,controlPort:control.address().port});
    log.emit('listener-starting',{host:HOST,port:PORT,deadline:current.pairingDeadline,sourceDigest:launch.pins.digest,filesystemAcquisition:false});
    const connected=await listen({host:HOST,port:PORT,token:launch.token,timeout:PAIRING_MS,onWaiting(){
      status('WAITING',{listenerReady:true});log.emit('listener-ready',{host:HOST,port:PORT});
      console.log(json({attempt:launch.attempt,state:'WAITING',privatePairingFile:path.join(launch.directory,'connect.txt')}));
    }});
    connection=connected.connection;
    traceConnection(connection,launch.directory,log);
    const native=new NativeClient(connection,connected.addresses);
    status('QUALIFYING',{pairingDeadline:null,listenerReady:false});
    log.emit('fresh-handshake',{addresses:connected.addresses});
    const proof=await qualify(native);
    exclusive(path.join(launch.directory,'qualification.json'),{...proof,attempt:launch.attempt,incarnation:launch.incarnation,filesystemAcquisition:false});
    status('QUALIFIED',{nativeOwnership:true,lastFreshReply:Date.now()});log.emit('qualification-completed',{scratchRestored:proof.scratchRestored,filesystemAcquisition:false});
    ref.current=createController({launch,native,connection,log,setStatus:status});
    await new Promise(resolve=>{
      connection.socket.once('close',resolve);
      const stop=async()=>{try{if(ref.current&&!ref.current.closed&&!ref.current.terminal)await ref.current.command({command:'stop'});}catch{}resolve();};
      process.once('SIGTERM',stop);process.once('SIGINT',stop);
      connection.socket.once('close',()=>{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);});
      if(connection.error||connection.socket.destroyed)resolve();
    });
    if(!ref.current.closed&&!ref.current.terminal)await ref.current.fail(connection.error||Error('Connection closed without normal stop'));
  } catch(error) {
    status('TERMINAL_UNCERTAIN',{error:error.message,nativeOwnership:false,replayAllowed:false});log.emit('terminal-uncertain',{error:error.message});
    connection?.close();throw error;
  } finally {finish();}
}
async function main(args=process.argv.slice(2)) {
  if(args.length===3&&args[0]==='--prepare'&&args[1]==='--preflight-receipt') {const launch=prepare(ROOT,Date.now(),args[2]);console.log(json({attempt:launch.attempt,directory:launch.directory,listenerStarted:false}));return;}
  if(args.length===4&&args[0]==='--serve'&&args[1]==='--attempt'&&args[3]==='--allow-console-listener') {await serveAttempt(args[2]);return;}
  throw Error('Usage: node host.cjs --prepare --preflight-receipt ABSOLUTE_RECEIPT | --serve --attempt ABSOLUTE_ATTEMPT --allow-console-listener');
}
module.exports={HOST,PORT,PAIRING_MS,SSH_CONFIG,sha,rejectRecovery,packagePins,validatePreflight,prepare,loadLaunch,traceConnection,createController,controlServer,serveAttempt};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
