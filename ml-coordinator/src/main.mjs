import {mkdirSync} from 'node:fs';
import {configuration,openRuntime,acquireApiLease} from './runtime.mjs';
import {createServer} from './api.mjs';

const config=configuration();
mkdirSync(config.stateDir,{recursive:true,mode:0o700});
let runtime;
try {runtime=await openRuntime(config);}catch{throw new Error('ML_COORDINATOR_STARTUP_FAILED');}
let server;
const release=await acquireApiLease(runtime.store,()=>stop().catch(()=>process.exit(1)));
server=createServer({...runtime,redisReady:async()=>{
  let timer;
  try {return await Promise.race([(async()=>await (await runtime.queue.client).ping()==='PONG')(),
    new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1500);timer.unref();})]);}
  catch{return false;}finally{clearTimeout(timer);}
}});
await runtime.inputs.reconcile(runtime.store);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
const timer=setInterval(()=>server.reconcileInputs().catch(()=>{}),60000);timer.unref();
let stopping=false;
async function stop() {
  if(stopping)return;stopping=true;clearInterval(timer);
  server.closeIdleConnections();
  await new Promise(resolve=>server.close(resolve));release();await runtime.close();
}
process.on('SIGTERM',()=>stop().catch(()=>process.exit(1)));
process.on('SIGINT',()=>stop().catch(()=>process.exit(1)));
