import {configuration,openRuntime} from './runtime.mjs';
import {startWorker,reconcile} from './worker.mjs';

const config=configuration();const runtime=await openRuntime(config);
const worker=startWorker({...runtime,queueName:config.queueName,connection:config.connection});
let reconciling=false,stopping=false;
async function dispatch() {
  if(reconciling || stopping)return;
  reconciling=true;
  try{await reconcile(runtime.store,runtime.queue);}catch{}finally{reconciling=false;}
}
const timer=setInterval(dispatch,1000);timer.unref();await dispatch();
async function stop() {
  if(stopping)return;stopping=true;clearInterval(timer);
  await worker.close();
  while(reconciling)await new Promise(resolve=>setTimeout(resolve,10));
  await runtime.close();
}
process.on('SIGTERM',()=>stop().catch(()=>process.exit(1)));
process.on('SIGINT',()=>stop().catch(()=>process.exit(1)));
