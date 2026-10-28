'use strict';
// Import is inert. No CLI starts a console listener or filesystem acquisition.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SCOPED_BRIDGE=path.join(__dirname,'scoped-bridge.cjs');
const CORE_ROOT=path.resolve(__dirname,'../core');
const TEMPLATE_MANIFEST=path.join(__dirname,'live-preflight/engine-source-manifest.json');
const TEMPLATE_MANIFEST_SHA256='__TEMPLATE_MANIFEST_SHA256__';
const STATUS='HOST_ONLY_PORT_NOT_HARDWARE_QUALIFIED';
const PREFIX=Object.freeze(['app/map','app/inspect-mounts','app/qualify','acquire','retained/find-metadata','ro/install-retained','ro/layout','ro/objects:root']);
const FORBIDDEN=new Set(['switch2/pipeline.cjs','switch2/cleanup-scratch.cjs','switch2/firmware-dump.cjs']);
const brands=new WeakSet(),must=(x,m)=>{if(!x)throw Error(m);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
function regular(p){const s=fs.lstatSync(p);must(s.isFile()&&!s.isSymbolicLink(),'Regular nonsymlink file required');return s;}
function directory(p){const s=fs.lstatSync(p);must(s.isDirectory()&&!s.isSymbolicLink(),'Nonsymlink directory required');return s;}
function read(p){regular(p);return JSON.parse(fs.readFileSync(p));}
function exclusive(p,value){const f=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(f,json(value));fs.fsyncSync(f);}finally{fs.closeSync(f);}}
function safeRelative(p){must(typeof p==='string'&&/^[A-Za-z0-9_./-]+$/.test(p)&&!path.isAbsolute(p)&&!p.split('/').some(x=>!x||x==='.'||x==='..'),'Unsafe source path');return p;}
function walk(p,prefix=''){const out=[];directory(p);for(const n of fs.readdirSync(p)){const q=path.join(p,n),s=fs.lstatSync(q);must(!s.isSymbolicLink(),'Symlink in source tree');if(s.isDirectory())out.push(...walk(q,prefix+n+'/'));else{must(s.isFile(),'Unsupported source object');out.push(prefix+n);}}return out.sort();}
function core(root=CORE_ROOT){
  const c=require(path.join(CORE_ROOT,'host.cjs'));
  must(c.packagePins(root).digest===c.packagePins(CORE_ROOT).digest,'L02 source package differs');return c;
}
function template(){
  regular(TEMPLATE_MANIFEST);const b=fs.readFileSync(TEMPLATE_MANIFEST);must(sha(b)===TEMPLATE_MANIFEST_SHA256,'Source template manifest changed');
  const m=JSON.parse(b);must(m.runtime_JSON_copied===false&&m.connection_metadata_present===false&&Array.isArray(m.files)&&m.files.length===90,'Source-only template differs');
  const names=new Set();for(const x of m.files){safeRelative(x.path);must(!FORBIDDEN.has(x.path)&&!names.has(x.path)&&/^[0-9a-f]{64}$/.test(x.sha256)&&Number.isSafeInteger(x.bytes)&&x.bytes>=0,'Unsafe source manifest');names.add(x.path);must(x.path.endsWith('.cjs')||m.JSON_allowlist.includes(x.path),'Runtime data is not a source asset');}
  must(JSON.stringify(walk(m.destination))===JSON.stringify([...names].sort()),'Source template contains missing or unexpected files');
  verifySources(m.destination,m.files);return m;
}
function ownedFile(p,root){must(path.resolve(p)===p&&p.startsWith(root+path.sep),'File outside owned namespace');directory(root);let q=path.dirname(p);while(q!==root){directory(q);q=path.dirname(q);}return regular(p);}
function readOwned(p,root){ownedFile(p,root);return JSON.parse(fs.readFileSync(p));}
function verifySources(engine,records){directory(engine);for(const x of records){const q=path.join(engine,safeRelative(x.path));const s=ownedFile(q,engine);must(s.size===x.bytes&&sha(fs.readFileSync(q))===x.sha256,'Pinned source changed: '+x.path);}}
function prepareBinding({attemptDirectory,l02Root=CORE_ROOT,expectedLauncherSha256,expectedScopedBridgeSha256,now=Date.now()}){
  const c=core(l02Root);c.rejectRecovery();const launch=c.loadLaunch(attemptDirectory,l02Root);
  must(expectedLauncherSha256===sha(fs.readFileSync(__filename)),'Launcher source pin differs');
  regular(SCOPED_BRIDGE);must(expectedScopedBridgeSha256===sha(fs.readFileSync(SCOPED_BRIDGE)),'Scoped bridge source pin differs');
  must(now>=launch.created,'Prepared attempt is from the future');
  const preflight=regular(launch.preflight.receiptPath);must(sha(fs.readFileSync(launch.preflight.receiptPath))===launch.preflight.sha256,'Preflight receipt changed');
  c.validatePreflight(launch.preflight.receiptPath,l02Root,launch.created);void preflight;
  must(!fs.existsSync(path.join(launch.directory,'host-reserved.json')),'Host attempt already consumed');
  const m=template(),engine=path.join(launch.directory,'seedsow-engine');must(!fs.existsSync(engine),'Isolation directory already exists');
  // Exclusive binding reservation precedes copying. A partial preparation is consumed.
  exclusive(path.join(launch.directory,'seedsow-binding-reserved.json'),{attempt:launch.attempt,incarnation:launch.incarnation,launcherSha256:expectedLauncherSha256,scopedBridgeSha256:expectedScopedBridgeSha256,templateSha256:TEMPLATE_MANIFEST_SHA256});
  fs.mkdirSync(engine,{mode:0o700});
  for(const x of m.files){const q=path.join(engine,x.path);fs.mkdirSync(path.dirname(q),{recursive:true,mode:0o700});fs.writeFileSync(q,fs.readFileSync(path.join(m.destination,x.path)),{flag:'wx',mode:0o600});}
  verifySources(engine,m.files);
  const b={schema:1,attempt:launch.attempt,incarnation:launch.incarnation,l02Root:path.resolve(l02Root),engine,sourceDigest:launch.pins.digest,launcherSha256:expectedLauncherSha256,scopedBridgeSha256:expectedScopedBridgeSha256,templateSha256:TEMPLATE_MANIFEST_SHA256,files:m.files,created:now,scope:'Fixed root prefix only; no target-save access'};
  exclusive(path.join(launch.directory,'seedsow-binding.json'),b);return {attempt:launch.attempt,engine,listenerStarted:false,filesystemAcquisition:false};
}
function loadBinding(attemptDirectory,l02Root=CORE_ROOT){
  regular(SCOPED_BRIDGE);const c=core(l02Root);c.rejectRecovery();const launch=c.loadLaunch(attemptDirectory,l02Root),b=read(path.join(launch.directory,'seedsow-binding.json'));
  must(b.schema===1&&b.attempt===launch.attempt&&b.incarnation===launch.incarnation&&b.sourceDigest===launch.pins.digest&&b.l02Root===path.resolve(l02Root)&&b.launcherSha256===sha(fs.readFileSync(__filename))&&b.scopedBridgeSha256===sha(fs.readFileSync(SCOPED_BRIDGE))&&b.templateSha256===TEMPLATE_MANIFEST_SHA256&&b.engine===path.join(launch.directory,'seedsow-engine'),'Fresh binding identity differs');
  const m=template();must(json(b.files)===json(m.files),'Binding source list differs');verifySources(b.engine,b.files);for(const x of b.files)Object.freeze(x);Object.freeze(b.files);Object.freeze(b);const ctx=Object.freeze({core:c,launch:Object.freeze(launch),binding:b});brands.add(ctx);return ctx;
}
function capture(r,earliest){must(r&&typeof r.path==='string','Capture missing');const s=regular(r.path),b=fs.readFileSync(r.path);must(b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&sha(b)===r.sha256&&b.length===r.bytes&&s.mtimeMs>=earliest,'Capture changed or predates reservation');return s;}
function validateCompletedPhases(ctx,proof,now=Date.now()){
  must(brands.has(ctx),'Unvalidated binding');const {launch}=ctx,phases=path.join(launch.directory,'phases'),epoch=read(path.join(phases,'epoch-confirmed.json'));
  must(epoch.attempt===launch.attempt&&epoch.incarnation===launch.incarnation&&epoch.sourceDigest===launch.pins.digest&&epoch.freshAppOpenedOperatorConfirmed===true,'Fresh application epoch differs');
  if(epoch.evidenceKind==='OPERATOR_FRESH_APP_READY'){
    const ref=epoch.operatorAttestation,file=path.join(launch.directory,'operator-ready-attestation.json');
    must(ref?.path===file&&fs.realpathSync(file)===file,'Operator attestation namespace differs');
    const st=regular(file),raw=fs.readFileSync(file);must((st.mode&0o077)===0&&st.uid===process.getuid()&&raw.length<=8192&&ref.bytes===raw.length&&ref.sha256===sha(raw),'Private operator attestation changed');
    const a=JSON.parse(raw);must(a.schema===1&&a.kind==='OPERATOR_FRESH_APP_READY'&&a.attempt===launch.attempt&&a.incarnation===launch.incarnation&&a.sourceDigest===launch.pins.digest&&a.userQuotation==='ready'&&a.operatorFreshAppOpened===true&&a.visualVerification===false&&Number.isSafeInteger(a.recordedUnixMs)&&a.recordedUnixMs>=launch.created&&a.recordedUnixMs<=now,'Operator attestation identity or receipt time differs');
  }else{
    must(epoch.evidenceKind===undefined,'Unsupported epoch evidence kind');
    const a=capture(epoch.closedCapture,launch.created),b=capture(epoch.directCapture,launch.created);must(epoch.closedCapture.sha256!==epoch.directCapture.sha256&&a.mtimeMs<b.mtimeMs,'Closed/Direct captures must be distinct and ordered');
  }
  const continuous=path.join(phases,'continuous-bootstrap-confirmed.json');
  if(fs.existsSync(continuous)){
    const batch=read(continuous),names=batch.confirmLoadWithKeyboardA?['load','load-confirm','run','remove','start']:batch.loadedProgram?['run','remove','start']:['load','run','remove','start'];
    must(batch.kind==='CONTINUOUS_BOOTSTRAP_NATIVE_QUALIFIED'&&batch.attempt===launch.attempt&&batch.incarnation===launch.incarnation&&batch.sourceDigest===launch.pins.digest&&batch.visualVerification===false&&JSON.stringify(batch.phases)===JSON.stringify(names)&&Array.isArray(batch.receipts)&&batch.receipts.length===names.length*2+1,'Continuous bootstrap identity differs');
    if(batch.confirmLoadWithKeyboardA){must(!batch.loadedProgram,'LOAD cannot be skipped with keyboard confirmation');const h=batch.inputHelper;must(h&&h.path===path.join(__dirname,'live-preflight/remote-community-phase.py')&&h.sha256==='__COMMUNITY_HELPER_SHA__','Community input helper identity differs');regular(h.path);must(sha(fs.readFileSync(h.path))===h.sha256,'Community input helper changed');}
    if(batch.loadedProgram){const ref=batch.loadedProgram,file=path.join(launch.directory,'loaded-program-evidence.json');must(ref.path===file,'Loaded program evidence namespace differs');regular(file);const raw=fs.readFileSync(file);must(raw.length===ref.bytes&&sha(raw)===ref.sha256,'Loaded program evidence changed');const e=JSON.parse(raw);must(e.kind==='NS2GOOD_LOADED_DIRECT_NO_NATIVE_SESSION'&&e.attempt===launch.attempt&&e.incarnation===launch.incarnation&&e.sourceDigest===launch.pins.digest&&e.loadedProgram==='TXT:NS2GOOD'&&e.nativeBootstrapExecuted===false&&e.priorSessionAccepted===false,'Loaded program state differs');regular(e.diagnostic.path);must(sha(fs.readFileSync(e.diagnostic.path))===e.diagnostic.sha256,'Diagnostic evidence changed');}
    const expected=names.flatMap(n=>[path.join(phases,n+'-reserved.json'),path.join(phases,n+'-result.json')]).concat(path.join(launch.directory,'qualification.json'));
    must(new Set(batch.receipts.map(x=>x.path)).size===names.length*2+1,'Duplicate bootstrap receipt');
    for(const file of expected){const ref=batch.receipts.find(x=>x.path===file);must(ref,'Bootstrap receipt missing');ownedFile(file,launch.directory);const raw=fs.readFileSync(file);must(raw.length===ref.bytes&&sha(raw)===ref.sha256,'Bootstrap receipt changed');}
    const commands={load:'LOAD "TXT:NS2GOOD"','load-confirm':'KEYS:RIGHT,A',run:'RUN',remove:'REMOVE NSR,&H60000000,&H3FFFFFFF',start:launch.connectCommand};let prior=0;
    for(const name of names){const r=read(path.join(phases,name+'-reserved.json')),o=read(path.join(phases,name+'-result.json'));must(r.attempt===launch.attempt&&r.incarnation===launch.incarnation&&r.sourceDigest===launch.pins.digest&&r.phase===name&&r.commandSha256===sha(Buffer.from(commands[name]))&&r.reservedUnixNs>prior&&o.attempt===launch.attempt&&o.phase===name&&o.returncode===0&&o.dispatched===true&&o.visualVerification===false,'Continuous input receipt differs');prior=r.reservedUnixNs;}
    must(Date.parse(proof.completed)>=prior/1e6,'Native proof predates START');
    for(const file of fs.readdirSync(phases)){if(file.endsWith('-uncertain.json'))throw Error('Unknown input outcome remains consumed');if(file.endsWith('-reserved.json'))must(names.includes(file.slice(0,-14)),'Unexpected reserved input phase');}
  }else{
  const observations={load:['direct-loaded','load-modal'],'load-confirm':['direct-loaded'],run:['boot-ready'],remove:['expected-out-of-memory'],start:['host-qualified']};
  const required=['load','run','remove','start'];if(read(path.join(phases,'load-confirmed.json')).observed==='load-modal')required.splice(1,0,'load-confirm');
  for(const name of required){const r=read(path.join(phases,name+'-reserved.json')),o=read(path.join(phases,name+'-result.json')),f=read(path.join(phases,name+'-confirmed.json'));must(r.attempt===launch.attempt&&r.incarnation===launch.incarnation&&r.sourceDigest===launch.pins.digest&&r.phase===name&&o.attempt===launch.attempt&&o.phase===name&&o.returncode===0&&o.dispatched===true&&f.attempt===launch.attempt&&f.phase===name&&f.sameHostIncarnation===launch.incarnation&&observations[name].includes(f.observed),'Input phase evidence differs');capture(f.capture,r.reservedUnixNs/1e6);if(name==='start')must(f.nativeQualificationChecked===true,'START lacks native qualification check');}
  for(const n of fs.readdirSync(phases).filter(x=>x.endsWith('-reserved.json'))){const name=n.slice(0,-14);const f=path.join(phases,name+'-result.json');must(fs.existsSync(f)&&read(f).dispatched===true,'Unknown input phase remains consumed');}
  }
  must(proof?.attempt===launch.attempt&&proof.incarnation===launch.incarnation&&proof.verified===true&&proof.scratchRestored===true&&proof.importRestored===true&&proof.platform===2&&Date.parse(proof.completed)>=launch.created&&now-Date.parse(proof.completed)>=0&&now-Date.parse(proof.completed)<=120000,'Fresh native qualification differs');
}
function guardNative(native,onTerminal=()=>{}){
  must(native&&native.connection&&typeof native.connection.fail==='function','Owned native connection required');
  const {AsyncLocalStorage}=require('node:async_hooks'),cleanupScope=new AsyncLocalStorage();
  let terminal=false,quiescing=false,providerOpen=true,pending=0,error;
  function fail(e){if(terminal)return;terminal=true;error=e instanceof Error?e:Error(String(e));native.connection.fail(error);try{onTerminal(error);}catch{}}
  const methods=new Set(['call','verifyFunction','callAddress','exchange','read','write','query','guard','stop']);
  function proxy(engineCapability,providerCapability=false){return new Proxy(native,{get(t,k){if(!methods.has(k))return Reflect.get(t,k,t);return async(...args)=>{
    must(!terminal&&!t.connection.error,'Native binding is terminal');
    must(!providerCapability||providerOpen,'Provider native ownership was released');
    const lease=cleanupScope.getStore();must(!lease||lease.active,'Owned cleanup scope expired');
    must(!quiescing||engineCapability||lease?.active===true,'External native calls are quiesced');
    pending++;try{return await Reflect.get(t,k,t).apply(t,args);}catch(e){fail(e);throw e;}finally{pending--;}
  };}});}
  return {native:proxy(false),providerNative:proxy(false,true),engineNative:proxy(true),fail,
    quiesce(){must(!terminal&&!quiescing&&pending===0,'Native binding is not known idle');quiescing=true;},
    resume(){must(!terminal&&quiescing&&pending===0,'Native cleanup is not idle');providerOpen=false;quiescing=false;},
    async ownedCleanup(fn){must(quiescing&&!terminal,'Owned cleanup requires quiescence');const lease={active:true};try{return await cleanupScope.run(lease,fn);}finally{lease.active=false;}},
    get terminal(){return terminal;},get quiescing(){return quiescing;},get pending(){return pending;},get error(){return error;}};
}
function createPrefixController({context,native,connection,proof,setStatus=()=>{},log={emit(){}},now=()=>Date.now(),services,readonlyFactory,stageTimeoutMs=600000}){
  must(readonlyFactory===undefined||typeof readonlyFactory==='function','readonlyFactory must be a function');
  must(brands.has(context),'Unvalidated binding');must(services&&typeof services.serveBridge==='function'&&typeof services.script==='function'&&typeof services.module==='function','Reviewed stage services required');
  must(Number.isInteger(stageTimeoutMs)&&stageTimeoutMs>=1&&stageTimeoutMs<=600000,'Invalid stage deadline');
  let state='QUALIFIED',terminal=false,abandoned=false,operation,bridge,acquisition,rootProof,adapter;
  const gate=guardNative(native,e=>{terminal=true;state='TERMINAL_UNCERTAIN';setStatus(state,{nativeOwnership:false,filesystemOwnership:false,error:e.message});});
  const base=context.core.createController({launch:context.launch,native:gate.native,connection,log,setStatus,now});
  const emit=(s,extra={})=>{state=s;setStatus(s,extra);};
  async function uncertain(e){gate.fail(e);if(acquisition&&!abandoned){abandoned=true;try{await acquisition.abandon();}catch{}}return {terminal:true};}
  async function stage(name,fn){must(!terminal,'Prefix is terminal');verifySources(context.binding.engine,context.binding.files);regular(SCOPED_BRIDGE);must(sha(fs.readFileSync(SCOPED_BRIDGE))===context.binding.scopedBridgeSha256,'Scoped bridge source changed');log.emit('fs-prefix-stage-reserved',{name});let timer;try{const deadline=new Promise((_r,reject)=>{timer=setTimeout(()=>{const e=Error('Stage deadline; native ownership unknown: '+name);gate.fail(e);reject(e);},stageTimeoutMs);});const value=await Promise.race([deadline,Promise.resolve().then(fn)]);must(!terminal,'Stage completed after terminal uncertainty');log.emit('fs-prefix-stage-completed',{name});return value;}catch(e){await uncertain(e);throw e;}finally{clearTimeout(timer);}}
  async function prefix(){
    const engine=context.binding.engine,session=context.launch.attempt;
    try{
      bridge=await stage('private-bridge',()=>services.serveBridge(gate.engineNative));
      must(typeof bridge.pauseHeartbeatAndDrain==='function'&&typeof bridge.drain==='function'&&Number.isInteger(bridge.pending)&&bridge.pending===0,'Owned bridge quiescence hooks missing');
      must(Number.isInteger(bridge.port)&&bridge.port>=1024&&bridge.port<=65535&&/^[0-9a-f]{64}$/.test(bridge.token),'Private bridge identity differs');
      bridge.keepAwake?.(proof.activity);
      exclusive(path.join(engine,'connection.json'),{port:bridge.port,token:bridge.token,addresses:{...native.addresses,session,target:'switch2'}});
      for(const n of ['map','inspect-mounts'])await stage('app/'+n,()=>services.script(engine,'app',n,[]));
      const app=await stage('app/qualify',()=>services.script(engine,'app','qualify',[]));must(app?.verified===true&&app.cleanedUp===true,'App qualification did not restore ownership');
      acquisition=await stage('acquire',()=>services.module(engine,'switch2/acquire.cjs').start());
      must(acquisition&&typeof acquisition.retire==='function'&&typeof acquisition.abandon==='function'&&typeof acquisition.report==='string'&&path.dirname(acquisition.report)===path.join(engine,'switch2/memory'),'Fresh acquisition owner missing');
      const report=readOwned(acquisition.report,engine);must(report.session===session&&report.memoryControl?.ready===true&&!report.placementUncertain&&!report.cleanupError&&!report.error,'Fresh acquisition evidence differs');
      if(!report.retainedMemory?.captures?.some(x=>x.length===0x4d8000))await stage('retained/find-metadata',()=>services.module(engine,'switch2/retained/find-metadata.cjs').main(acquisition.supervisorReport));
      await stage('ro/install-retained',()=>services.script(engine,'ro','install-retained',[]));
      await stage('ro/layout',()=>services.module(engine,'switch2/ro/layout.cjs').main());
      await stage('ro/objects:root',()=>services.module(engine,'switch2/ro/objects.cjs').main('root'));
      rootProof=readOwned(path.join(engine,'switch2/ro/root/current-root.json'),engine);
      must(rootProof.session===session&&rootProof.report===acquisition.report&&rootProof.pid===1&&Number.isInteger(rootProof.rootHandle)&&rootProof.rootHandle>0&&rootProof.bisAccessVerified===false&&path.dirname(rootProof.proof)===path.join(engine,'switch2/ro/root'),'Owned root proof differs');
      const evidence=readOwned(rootProof.proof,engine);must(evidence.success===true&&evidence.cloneIdentityVerified===true&&evidence.session===session&&evidence.report===acquisition.report&&evidence.rootHandle===rootProof.rootHandle,'Root clone identity proof missing');
      emit('FS_ROOT_READY',{nativeOwnership:true,filesystemOwnership:true,saveFilesystemOpened:false,rootProofFile:path.join(engine,'switch2/ro/root/current-root.json')});
      return {ready:true,session,rootHandle:rootProof.rootHandle,kind:'session',saveFilesystemOpened:false};
    }catch(e){await uncertain(e);throw e;}
  }
  async function closeBridge(){if(bridge){const b=bridge;bridge=null;await b.close();}}
  async function release(drained){
    try{
      await stage('bridge/quiesce',()=>drained);
      must(gate.pending===0&&bridge.pending===0,'Native work appeared before adapter cleanup');
      if(adapter){
        const r=await stage('adapter/close',()=>gate.ownedCleanup(()=>adapter.close()));
        must(r?.knownIdle===true&&r.ownedResourcesClosed===true,'Adapter resources unqualified');
        must(gate.pending===0&&bridge.pending===0,'Adapter cleanup is still pending');adapter=null;
      }
      // A durable retirement reservation follows proof of closed adapter resources.
      exclusive(path.join(context.launch.directory,'fs-root-release-reserved.json'),{attempt:context.launch.attempt,incarnation:context.launch.incarnation,unixMs:now(),replayAllowed:false});
      const r=await stage('acquire/retire',()=>acquisition.retire());
      must(r?.cleanedUp===true,'Acquisition did not retire');
      await stage('bridge/drain',()=>bridge.drain());must(gate.pending===0&&bridge.pending===0,'Retirement native work remains pending');
      acquisition=null;rootProof=undefined;await stage('bridge/close',()=>closeBridge());gate.resume();
      emit('QUALIFIED',{nativeOwnership:true,filesystemOwnership:false});return r;
    }catch(e){await uncertain(e);throw e;}
  }
  function providerContext(){
    must(state==='FS_ROOT_READY'&&!terminal&&!operation&&gate.pending===0&&bridge.pending===0,'Owned root is not idle');
    return {native:gate.providerNative,connection,rootProof,liveIdentity:Object.freeze({sessionId:context.launch.attempt,incarnation:context.launch.incarnation}),ramLeaseVerified:false,saveFilesystemOpened:false};
  }
  async function prepareReadonly(input,drained){
    try{
      await stage('readonly/quiesce-heartbeat',()=>drained);
      must(gate.pending===0&&bridge.pending===0,'Native work appeared before readonly preparation');
      const value=await stage('readonly/factory',()=>gate.ownedCleanup(()=>readonlyFactory(input)));
      must(value&&typeof value.close==='function','Readonly factory must return an adapter with close');
      must(gate.pending===0&&bridge.pending===0,'Readonly preparation left native work pending');adapter=value;
      emit('READONLY_READY',{nativeOwnership:true,filesystemOwnership:true,saveFilesystemOpened:false});return {ready:true};
    }catch(e){await uncertain(e);throw e;}
  }
  async function importSave(){
    try{
      const result=await stage('save/import',()=>gate.ownedCleanup(()=>adapter.importSave()));
      must(result&&['complete','unqualified'].includes(result.outcome)&&result.knownIdle===true&&result.ownedResourcesRetained===true&&typeof result.reportPath==='string','Save import ownership result differs');
      must(gate.pending===0&&bridge.pending===0,'Save import left native work pending');
      readOwned(result.reportPath,context.launch.directory);
      emit(result.outcome==='complete'?'SAVE_IMPORT_COMPLETE':'IMPORT_UNQUALIFIED',{nativeOwnership:true,filesystemOwnership:true,importReportPath:result.reportPath});return result;
    }catch(e){await uncertain(e);throw e;}
  }
  async function command(req){
    if(req.command==='status')return {state,busy:!!operation,terminal,closed:base.closed,nativePending:gate.pending,releaseAvailability:'AVAILABLE_WHEN_IDLE',nativeQuiescing:gate.quiescing,liveIdentity:{sessionId:context.launch.attempt,incarnation:context.launch.incarnation},ramLeaseVerified:false,saveFilesystemOpened:false};
    must(!terminal&&!operation,'Binding is busy or terminal');
    if(req.command==='fs-root-prefix'){
      must(state==='QUALIFIED','Root prefix is not available');validateCompletedPhases(context,proof,now());
      must(!fs.existsSync(path.join(context.binding.engine,'connection.json')),'Engine connection was already generated');
      must(JSON.stringify(walk(context.binding.engine))===JSON.stringify(context.binding.files.map(x=>x.path).sort()),'Preseeded runtime state is prohibited');
      exclusive(path.join(context.launch.directory,'fs-root-prefix-reserved.json'),{attempt:context.launch.attempt,incarnation:context.launch.incarnation,sourceDigest:context.launch.pins.digest,templateSha256:TEMPLATE_MANIFEST_SHA256,prefix:PREFIX,unixMs:now(),replayAllowed:false});
      emit('FS_PREFIX_RUNNING',{filesystemOwnership:false});operation=prefix();operation.then(()=>{operation=null;},()=>{operation=null;});return {reserved:true,automaticAfterQualification:false};
    }
    if(req.command==='readonly-prepare'){
      must(state==='FS_ROOT_READY'&&acquisition&&!adapter,'Readonly preparation is not available');
      must(typeof readonlyFactory==='function','No reviewed readonly factory is configured');
      const provider=providerContext();
      const input={providerContext:provider,engine:context.binding.engine,sourceFiles:context.binding.files,qualifiedAt:Date.parse(proof.completed),attemptDirectory:context.launch.directory};
      exclusive(path.join(context.launch.directory,'readonly-prepare-reserved.json'),{attempt:context.launch.attempt,incarnation:context.launch.incarnation,unixMs:now(),replayAllowed:false});
      gate.quiesce();let drained;operation=Promise.resolve().then(()=>prepareReadonly(input,drained));
      operation.then(()=>{operation=null;},()=>{operation=null;});
      try{drained=bridge.pauseHeartbeatAndDrain();emit('READONLY_PREPARING');return {reserved:true};}catch(e){await uncertain(e);throw e;}
    }
    if(req.command==='import-save'){
      must(state==='READONLY_READY'&&gate.quiescing&&acquisition&&adapter,'Save import is not available');
      must(typeof adapter.importSave==='function','No reviewed save import hook is configured');
      must(gate.pending===0&&bridge.pending===0,'Native work is pending; save import requires known idle');
      exclusive(path.join(context.launch.directory,'save-import-reserved.json'),{attempt:context.launch.attempt,incarnation:context.launch.incarnation,unixMs:now(),replayAllowed:false});
      operation=Promise.resolve().then(()=>importSave());operation.then(()=>{operation=null;},()=>{operation=null;});emit('SAVE_IMPORT_RUNNING');return {reserved:true};
    }
    if(req.command==='release-fs'){
      must(['FS_ROOT_READY','READONLY_READY','SAVE_IMPORT_COMPLETE','IMPORT_UNQUALIFIED'].includes(state)&&acquisition,'No known owned root to release');
      must(gate.pending===0&&bridge.pending===0,'Native work is pending; release requires known idle');
      // No await between idle check, provider sealing, heartbeat pause and busy flag.
      if(!gate.quiescing)gate.quiesce();
      try{
        const drained=bridge.pauseHeartbeatAndDrain();
        operation=Promise.resolve().then(()=>release(drained));
        operation.then(()=>{operation=null;},()=>{operation=null;});emit('FS_RELEASING');return {reserved:true};
      }catch(e){await uncertain(e);throw e;}
    }
    if(req.command==='stop'){must(state==='QUALIFIED'&&!bridge&&!acquisition,'Release known FS resources before normal stop');const r=await base.command(req);state='CLOSED';return r;}
    throw Error('Only passive status, fixed root prefix, explicit readonly preparation, save import, release and normal stop are supported');
  }
  return {command,fail:uncertain,get terminal(){return terminal;},get closed(){return base.closed;},get operation(){return operation;},get rootProof(){return rootProof;},
    providerContext,
    attachReadonlyAdapter(value){must(state==='FS_ROOT_READY'&&!terminal&&!operation&&gate.pending===0&&bridge.pending===0&&!adapter,'Cannot attach adapter');must(value&&typeof value.close==='function','Readonly adapter release hook required');adapter=value;},
    async shutdown(){if(!base.closed&&!terminal)await uncertain(Error('Host binding closed without normal stop'));try{await closeBridge();}catch{}},
  };
}
function reviewedServices(engine){
  const modules=new Map();return {serveBridge:native=>require(SCOPED_BRIDGE).serve(native),
    script:(_engine,folder,name,args)=>{must(['app/map','app/inspect-mounts','app/qualify','ro/install-retained'].includes(folder+'/'+name)&&args.length===0,'Forbidden stage');return require(path.join(engine,'shared/stages.cjs')).run(path.join(engine,'switch2',folder),name,args);},
    module:(_engine,name)=>{must(['switch2/acquire.cjs','switch2/retained/find-metadata.cjs','switch2/ro/layout.cjs','switch2/ro/objects.cjs'].includes(name),'Forbidden module');if(!modules.has(name))modules.set(name,require(path.join(engine,name)));return modules.get(name);}};
}
async function serveAttempt({attemptDirectory,l02Root=CORE_ROOT,allowConsoleListener=false,readonlyFactory}){
  must(allowConsoleListener===true,'Explicit console-listener gate required');
  must(readonlyFactory===undefined||typeof readonlyFactory==='function','readonlyFactory must be a function');
  const ctx=loadBinding(attemptDirectory,l02Root),{core:c,launch}=ctx;
  must(Date.now()>=launch.created,'Prepared binding is from the future');
  exclusive(path.join(launch.directory,'host-reserved.json'),{attempt:launch.attempt,pid:process.pid,scope:'L02 bootstrap plus separately gated root prefix',launcherSha256:ctx.binding.launcherSha256});
  const log=c.traceConnection&&(()=>{const f=fs.openSync(path.join(launch.directory,'host-events.jsonl'),'ax',0o600);return {emit(t,x={}){fs.writeSync(f,JSON.stringify({type:t,utc:new Date().toISOString(),...x})+'\n');fs.fsyncSync(f);},close(){fs.closeSync(f);}};})();
  let state={state:'STARTING',nativeOwnership:false},connection,controller;const ref={current:null};
  const setStatus=(s,extra={})=>{state={...state,...extra,state:s,updated:Date.now(),attempt:launch.attempt,incarnation:launch.incarnation,pid:process.pid,pinsDigest:launch.pins.digest};fs.writeFileSync(path.join(launch.directory,'status.json'),json(state),{mode:0o600});};
  const control=await c.controlServer(launch,()=>state,ref);let signal;
  try{
    setStatus('WAITING',{pairingDeadline:Date.now()+c.PAIRING_MS,controlPort:control.address().port});
    const {listen}=require(path.join(CORE_ROOT,'sources/connection.cjs')),{NativeClient}=require(path.join(CORE_ROOT,'sources/native.cjs')),{qualify}=require(path.join(CORE_ROOT,'sources/qualify.cjs'));
    const connected=await listen({host:c.HOST,port:c.PORT,token:launch.token,timeout:c.PAIRING_MS,onWaiting(){setStatus('WAITING',{listenerReady:true});}});connection=connected.connection;log.emit('established-transport',{perPacketDiskTrace:false});
    const native=new NativeClient(connection,connected.addresses);setStatus('QUALIFYING',{listenerReady:false,pairingDeadline:null});const proof={...await qualify(native),attempt:launch.attempt,incarnation:launch.incarnation,filesystemAcquisition:false};exclusive(path.join(launch.directory,'qualification.json'),proof);setStatus('QUALIFIED',{nativeOwnership:true});
    controller=createPrefixController({context:ctx,native,connection,proof,setStatus,log,readonlyFactory,services:reviewedServices(ctx.binding.engine)});ref.current=controller;
    await new Promise(resolve=>{connection.socket.once('close',resolve);signal=()=>{controller.fail(Error('Host interrupted')).finally(resolve);};process.once('SIGTERM',signal);process.once('SIGINT',signal);if(connection.error||connection.socket.destroyed)resolve();});
  }catch(e){connection?.fail(e);setStatus('TERMINAL_UNCERTAIN',{nativeOwnership:false,filesystemOwnership:false,error:e.message});throw e;}
  finally{if(signal){process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);}if(controller)await controller.shutdown();control.close();log.close();}
}
module.exports={STATUS,CORE_ROOT,TEMPLATE_MANIFEST_SHA256,PREFIX,prepareBinding,loadBinding,validateCompletedPhases,guardNative,createPrefixController,reviewedServices,serveAttempt};
