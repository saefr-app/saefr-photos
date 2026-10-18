import {readFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {Queue} from 'bullmq';
import {Store} from './lifecycle-store.mjs';
import {Inputs} from './inputs.mjs';
import {InferenceClient} from './inference-client.mjs';
import {Authorizer} from './auth.mjs';
import {Failure,fields,integer} from './protocol.mjs';

export function configuration(env=process.env) {
  try {
    for(const key of ['ML_STATE_DIR','ML_ACCESS_FILE','ML_MODELS_FILE','ML_REDIS_HOST','ML_REDIS_PORT','ML_QUEUE_NAME'])
      if(!env[key])throw new Error('missing');
    if(!/^saefr-ml-[a-zA-Z0-9-]{6,80}$/.test(env.ML_QUEUE_NAME))throw new Error('queue namespace');
    const raw=readFileSync(env.ML_MODELS_FILE,'utf8');if(Buffer.byteLength(raw)>65536)throw new Error('large');
    const config=fields(JSON.parse(raw),['models']);
    if(!Array.isArray(config.models) || !config.models.length || config.models.length>8)throw new Error('models');
    const routes=config.models.map(entry=>{
      fields(entry,['model','url','token_env']);
      if(!/^ML_[A-Z0-9_]{1,60}$/.test(entry.token_env))throw new Error('token variable');
      return {model:entry.model,url:entry.url,token:env[entry.token_env]};
    });
    return {stateDir:resolve(env.ML_STATE_DIR),accessFile:resolve(env.ML_ACCESS_FILE),routes,
      connection:{host:env.ML_REDIS_HOST,port:integer(Number(env.ML_REDIS_PORT),1,65535),
        ...(env.ML_REDIS_PASSWORD?{password:env.ML_REDIS_PASSWORD}:{}),maxRetriesPerRequest:null},
      queueName:env.ML_QUEUE_NAME,port:integer(Number(env.ML_API_PORT??8002),1,65535),
      host:env.ML_API_HOST??'127.0.0.1',maxAssets:integer(Number(env.ML_MAX_ASSETS??10000)),
      maxBytes:integer(Number(env.ML_CACHE_MAX_BYTES??1024**3))};
  } catch {throw new Failure('INVALID_CONFIGURATION',503);}
}

export async function openRuntime(config) {
  mkdirSync(config.stateDir,{recursive:true,mode:0o700});
  const store=new Store(join(config.stateDir,'saefr-ml.sqlite'),{maxAssets:config.maxAssets,maxBytes:config.maxBytes});
  const inputs=new Inputs(join(config.stateDir,'inputs'));await inputs.init();
  const inference=new InferenceClient(config.routes);
  const authorizer=new Authorizer(config.accessFile);
  const queue=new Queue(config.queueName,{connection:{...config.connection,maxRetriesPerRequest:1,
    enableOfflineQueue:false,connectTimeout:2000}});
  queue.on('error',()=>{});
  return {store,inputs,inference,authorizer,queue,close:async()=>{await queue.close();store.close();}};
}

export async function acquireApiLease(store,onLost,{ttl=15000,wait=20000}={}) {
  const owner=randomUUID();const deadline=Date.now()+wait;
  while(true) {
    const acquired=store.transaction(()=>{
      const current=store.db.prepare('SELECT * FROM api_lease WHERE id=1').get();
      if(current && current.expires_at>Date.now())return false;
      store.db.prepare('INSERT OR REPLACE INTO api_lease VALUES (1,?,?)').run(owner,Date.now()+ttl);
      return true;
    });
    if(acquired)break;
    if(Date.now()>=deadline)throw new Failure('API_ALREADY_RUNNING',503);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  store.apiOwner=owner;let released=false;
  const timer=setInterval(()=>{
    try {store.transaction(()=>store.db.prepare('UPDATE api_lease SET expires_at=? WHERE id=1 AND owner=?')
      .run(Date.now()+ttl,owner));}
    catch {clearInterval(timer);onLost();}
  },Math.max(10,Math.floor(ttl/3)));timer.unref();
  return ()=>{
    if(released)return;released=true;clearInterval(timer);store.apiOwner=null;
    store.db.prepare('DELETE FROM api_lease WHERE id=1 AND owner=?').run(owner);
  };
}
