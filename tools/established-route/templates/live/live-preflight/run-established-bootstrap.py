#!/usr/bin/env python3
"""One-use established HID sequence; success comes from final native qualification."""
import sys,json,time,hashlib
from pathlib import Path
CORE=Path(__file__).resolve().parents[2]/'core'
sys.path.insert(0,str(CORE))
import phase
attempt=Path(sys.argv[1]).resolve(strict=True);host=sys.argv[2]
def ref(p):
 b=p.read_bytes();return {'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
l=phase.load_launch(attempt)
HELPER=Path(__file__).with_name('remote-community-phase.py')
HELPER_SHA='__COMMUNITY_HELPER_SHA__'
if hashlib.sha256(HELPER.read_bytes()).hexdigest()!=HELPER_SHA:raise ValueError('Community input helper changed')
credential=phase.prompt_credential()
try:
 with phase.locked(attempt):
  phase.check_waiting(l,phase.live_control(l))
  epoch=json.loads((attempt/'phases/epoch-confirmed.json').read_text())
  if epoch.get('attempt')!=l['attempt'] or epoch.get('incarnation')!=l['incarnation'] or epoch.get('sourceDigest')!=l['pins']['digest'] or epoch.get('freshAppOpenedOperatorConfirmed') is not True:raise ValueError('Fresh operator epoch missing')
  phase.exclusive(attempt/'continuous-bootstrap-reserved.json',{'attempt':l['attempt'],'incarnation':l['incarnation'],'sourceDigest':l['pins']['digest'],'visualVerification':False,'replayAllowed':False})
  names=['load','load-confirm','run','remove','start'];receipts=[]
  for name in names:
   phase.load_launch(attempt)
   probe=phase.preflight(host,True,credential)
   phase.exclusive(attempt/'phases'/('preflight-'+str(time.time_ns())+'.json'),{'attempt':l['attempt'],'phase':name,**probe})
   if not probe['ready'] or probe['sourceDigest']!=l['pins']['digest']:raise ValueError('Fresh input preflight failed; next phase not sent')
   reply=phase.live_control(l);phase.check_waiting(l,reply);command=phase.command_for(l,name);command_sha=phase.digest((command or 'KEYS:RIGHT,A').encode());stamp=time.time_ns()
   reserved=attempt/'phases'/(name+'-reserved.json')
   phase.exclusive(reserved,{'attempt':l['attempt'],'incarnation':l['incarnation'],'phase':name,'sourceDigest':l['pins']['digest'],'reservedUnixNs':stamp,'commandSha256':command_sha,'outcome':'unknown until exact sender reply','replayAllowed':False})
   ticket={'attempt':l['attempt'],'phase':name,'command':command,'commandSha256':command_sha,'encoderSha256':l['encoderSha256'],'expiresUnix':reply['pairingDeadline']/1000}
   outcome=phase.remote_call(host,str(HELPER),ticket,True,credential);remote=outcome.get('document') or {}
   okay=outcome['returncode']==0 and remote.get('attempt')==l['attempt'] and remote.get('phase')==name and remote.get('dispatched') is True
   result=attempt/'phases'/(name+'-result.json')
   phase.exclusive(result,{'attempt':l['attempt'],'phase':name,'returncode':outcome['returncode'],'transportError':outcome.get('transportError'),'dispatched':okay,'visualVerification':False,'remoteReceipt':remote.get('receipt'),'replayAllowed':False})
   if not okay:
    phase.exclusive(attempt/'phases'/(name+'-uncertain.json'),{'attempt':l['attempt'],'phase':name,'replayAllowed':False});raise ValueError('Unknown sender outcome; no next phase or replay')
   receipts.extend([ref(reserved),ref(result)])
   print(json.dumps({'phase':name,'keyboardDelivered':True}),flush=True)
   time.sleep(3 if name in ['load','load-confirm'] else 8 if name=='run' else 2)
  until=time.monotonic()+120
  while True:
   reply=phase.live_control(l)
   if reply.get('state')=='QUALIFIED' and reply.get('nativeOwnership') is True:break
   if reply.get('terminal') or time.monotonic()>=until:raise ValueError('Native qualification not established; no FS command sent')
   time.sleep(1)
  qfile=attempt/'qualification.json';q=json.loads(qfile.read_text());start=json.loads((attempt/'phases/start-reserved.json').read_text())
  from datetime import datetime
  completed=datetime.fromisoformat(q['completed'].replace('Z','+00:00')).timestamp()*1000
  if not(q.get('attempt')==l['attempt'] and q.get('incarnation')==l['incarnation'] and q.get('verified') is True and q.get('scratchRestored') is True and q.get('importRestored') is True and q.get('platform')==2 and completed>=start['reservedUnixNs']/1000000):raise ValueError('Final native proof identity or freshness differs')
  receipts.append(ref(qfile));phase.exclusive(attempt/'phases/continuous-bootstrap-confirmed.json',{'confirmLoadWithKeyboardA':True,'inputHelper':ref(HELPER),'kind':'CONTINUOUS_BOOTSTRAP_NATIVE_QUALIFIED','attempt':l['attempt'],'incarnation':l['incarnation'],'sourceDigest':l['pins']['digest'],'visualVerification':False,'phases':names,'receipts':receipts})
  print(json.dumps({'bootstrap':'QUALIFIED','phases':names,'captureChecks':0}),flush=True)
  reply=phase.live_control(l,'fs-root-prefix');print(json.dumps({'filesystemAcquisitionRequested':True,'state':reply.get('state')}),flush=True)
finally:
 credential=None
