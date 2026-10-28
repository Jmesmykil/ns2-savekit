"use strict";
// Private capability for the pinned isolated engine only. Provider callers use
// the launcher's separate native guard and never receive this HTTP token.
const http=require('node:http'),crypto=require('node:crypto');
async function serve(native){
  const token=crypto.randomBytes(32).toString('hex');
  let queue=Promise.resolve(),queued=0,requests=0,paused=false,closed=false,activity,lastActivity=0;
  const idleWaiters=new Set();
  function notify(){if(!queued&&!requests)for(const resolve of idleWaiters){idleWaiters.delete(resolve);resolve();}}
  function drain(){return queued||requests?new Promise(resolve=>idleWaiters.add(resolve)):Promise.resolve();}
  function enqueue(task){queued++;const result=queue.then(task);queue=result.catch(()=>{});return result.finally(()=>{queued--;notify();});}
  async function handle(request){
    if(!request||typeof request!=='object'||Array.isArray(request))throw Error('Bridge request must be an object');
    const {command}=request;
    if(command==='status')return {ready:!native.connection.error,calls:native.calls};
    if(command==='call'){const reply=await native.call(request.offset,...request.args);return {result:reply.result.toString(),output:reply.output.toString('base64')};}
    if(command==='verify-function'){
      if(typeof request.hex!=='string'||!/^(?:[0-9a-f]{2}){4,256}$/i.test(request.hex))throw Error('Expected original native instruction bytes');
      await native.verifyFunction(request.address,Buffer.from(request.hex,'hex'));return {verified:true};
    }
    if(command==='call-address'){const reply=await native.callAddress(request.address,...request.args);return {result:reply.result.toString(),output:reply.output.toString('base64')};}
    if(command==='pair'){const reply=await native.exchange(request.calls);return {results:reply.results.map(String),output:reply.output.toString('base64')};}
    if(command==='read')return {data:(await native.read(request.address,request.length)).toString('base64')};
    if(command==='write'){await native.write(request.address,Buffer.from(request.data,'base64'));return {written:true};}
    if(command==='query')return native.query(request.address);
    throw Error('Unknown bridge command');
  }
  const server=http.createServer(async(req,res)=>{
    if(closed||req.method!=='POST'||req.url!=='/'||req.headers.authorization!=='Bearer '+token){res.writeHead(403).end();return;}
    requests++;
    try{
      const parts=[];let length=0;
      for await(const part of req){length+=part.length;if(length>2*1024*1024)throw Error('Bridge request is too large');parts.push(part);}
      const request=JSON.parse(Buffer.concat(parts)),result=await enqueue(()=>handle(request));
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?value.toString():value));
    }catch(error){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}));}
    finally{requests--;notify();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const heartbeat=setInterval(()=>{
    if(paused||closed)return;
    enqueue(async()=>{
      if(paused||closed||native.connection.error)return;
      if(activity&&Date.now()-lastActivity>30000){const reply=await native.call(activity.offset,activity.controller);if(reply.result)throw Error('Console activity report failed');lastActivity=Date.now();}
      else await native.call(0x5872f0,native.output,native.output,0);
    }).catch(error=>native.connection.fail(error));
  },5000);heartbeat.unref();
  function pauseHeartbeatAndDrain(){paused=true;clearInterval(heartbeat);return drain();}
  return {
    port:server.address().port,token,
    get pending(){return queued+requests;},get heartbeatPaused(){return paused;},
    keepAwake(value){activity=value;},drain,pauseHeartbeatAndDrain,
    async close(){closed=true;paused=true;clearInterval(heartbeat);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await drain();},
  };
}
module.exports={serve};
