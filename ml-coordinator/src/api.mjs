import {createServer as httpServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Failure,fields,identifier,integer,MAX_JSON,HASH} from './protocol.mjs';
import {similar,duplicateSuggestions} from './similarity.mjs';

async function jsonBody(request) {
  if ((request.headers['content-type']??'').split(';')[0].toLowerCase()!=='application/json')
    throw new Failure('INVALID_REQUEST');
  let size=0;const chunks=[];
  const timer=setTimeout(()=>request.destroy(),15000);timer.unref();
  try {
    for await (const chunk of request.iterator({destroyOnReturn:false})) {
      size+=chunk.length;
      if (size>MAX_JSON) throw new Failure('PAYLOAD_TOO_LARGE',413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Failure('INVALID_REQUEST'); }
  } finally { clearTimeout(timer); }
}

function summary(job) {
  return {id:job.id,state:job.state,attempts:job.attempts,error_code:job.error_code,
    model_key:job.model_key,updated_at:job.updated_at};
}

export function createServer({store,inputs,inference,authorizer,redisReady=async()=>true}) {
  let mutating=false,queries=0;
  async function mutation(operation) {
    if(mutating)throw new Failure('BUSY',429,true);
    mutating=true;
    try{return await operation();}finally{mutating=false;}
  }
  const server=httpServer({maxHeaderSize:16384,requestTimeout:20000,headersTimeout:10000,keepAliveTimeout:5000},
    async(request,response)=>{
      const send=(status,value)=>{
        if(response.destroyed)return;
        const bytes=Buffer.from(JSON.stringify(value));
        response.writeHead(status,{'Content-Type':'application/json','Content-Length':bytes.length,
          'Cache-Control':'no-store',...(status>=400?{'Connection':'close'}:{})});
        response.end(bytes);
      };
      try {
        const url=new URL(request.url,'http://local');
        if(request.method==='GET' && url.pathname==='/health/live')return send(200,{status:'ok'});
        if(request.method==='GET' && url.pathname==='/health/ready') {
          authorizer.authorize(request,null,'admin');
          const ready=await redisReady();return send(ready?200:503,{status:ready?'ready':'unavailable'});
        }
        const match=/^\/v1\/scopes\/([^/]+)(.*)$/.exec(url.pathname);
        if(!match)throw new Failure('NOT_FOUND',404);
        const scopeId=match[1],tail=match[2];
        const manage=request.method!=='GET' && tail!=='/search' && tail!=='/duplicates';
        authorizer.authorize(request,scopeId,manage?'manage':'search');
        identifier(scopeId);
        if(request.method==='PUT' && tail==='')return await mutation(async()=>{
          authorizer.authorize(request,null,'admin');
          const body=fields(await jsonBody(request),['model_key']);
          authorizer.authorize(request,null,'admin');
          const scope=store.createScope(scopeId,inference.model(body.model_key));
          send(200,{id:scope.id,...store.coverage(scopeId)});
        });
        if(request.method==='GET' && tail==='/status') {
          authorizer.authorize(request,scopeId,'manage');
          return send(200,store.coverage(scopeId));
        }
        if(request.method==='POST' && tail==='/search') {
          if(queries>=4)throw new Failure('BUSY',429,true);
          queries++;
          try {
            const body=fields(await jsonBody(request),['text','limit','min_score'],['text']);
            if(typeof body.text!=='string' || !body.text.trim() || body.text.length>1024)
              throw new Failure('INVALID_REQUEST');
            if('limit' in body)integer(body.limit,1,100);
            if('min_score' in body && (typeof body.min_score!=='number' || !Number.isFinite(body.min_score)
              || body.min_score < -1 || body.min_score > 1))throw new Failure('INVALID_REQUEST');
            const scope=store.scope(scopeId);
            const vector=await inference.searchVector(scopeId,store.model(scope.active_model),body.text);
            authorizer.authorize(request,scopeId,'search');
            return send(200,store.search(scopeId,scope.active_model,vector,
              {limit:body.limit??20,minScore:body.min_score??-1}));
          } finally {queries--;}
        }
        if(request.method==='POST' && tail==='/duplicates') {
          const body=fields(await jsonBody(request),['asset_ids','min_score'],['asset_ids']);
          authorizer.authorize(request,scopeId,'search');
          return send(200,duplicateSuggestions(store,scopeId,body.asset_ids,body.min_score??0.995));
        }
        const assetMatch=/^\/assets\/([^/]+)(.*)$/.exec(tail);
        if(assetMatch) {
          const assetId=identifier(assetMatch[1]),operation=assetMatch[2];
          if(request.method==='GET' && operation==='') {
            authorizer.authorize(request,scopeId,'manage');
            return send(200,store.assetStatus(scopeId,assetId));
          }
          if(request.method==='PUT' && operation==='')return await mutation(async()=>{
            store.scope(scopeId);
            const rawGeneration=request.headers['x-asset-generation']??'';
            if(!/^[1-9][0-9]{0,15}$/.test(rawGeneration))throw new Failure('INVALID_REQUEST');
            const generation=integer(Number(rawGeneration));let accepted;
            try {
              accepted=await inputs.accept(request,scopeId,assetId,generation);
              authorizer.authorize(request,scopeId,'manage');
              const result=store.registerAndQueue(scopeId,assetId,generation,accepted.image,accepted.key);
              await inputs.removeUnused(store,result.obsoleteInputs);
              return send(202,{asset_id:assetId,generation,job:summary(result.job)});
            } catch(error) {
              if(accepted)await inputs.removeUnused(store,[accepted.key]);
              throw error;
            }
          });
          if(request.method==='GET' && operation==='/similar') {
            const keys=[...url.searchParams.keys()];
            if(keys.some(key=>!['limit','min_score'].includes(key)) || new Set(keys).size!==keys.length)
              throw new Failure('INVALID_REQUEST');
            return send(200,similar(store,scopeId,assetId,{
              limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):20,
              minScore:url.searchParams.has('min_score')?Number(url.searchParams.get('min_score')):-1}));
          }
          if(request.method==='POST' && operation==='/lifecycle')return await mutation(async()=>{
            const body=fields(await jsonBody(request),['generation','state']);
            authorizer.authorize(request,scopeId,'manage');
            const result=store.lifecycle(scopeId,assetId,body.generation,body.state);
            await inputs.removeUnused(store,result.obsoleteInputs);
            return send(200,{applied:result.applied});
          });
          if(request.method==='POST' && operation==='/move')return await mutation(async()=>{
            const body=fields(await jsonBody(request),['generation','destination_scope']);
            authorizer.authorize(request,scopeId,'manage');
            authorizer.authorize(request,body.destination_scope,'manage');
            const result=store.move(scopeId,assetId,body.destination_scope,body.generation);
            await inputs.removeUnused(store,result.obsoleteInputs);return send(200,{applied:result.applied});
          });
        }
        if(request.method==='PATCH' && tail==='/settings')return await mutation(async()=>{
          const body=fields(await jsonBody(request),['enabled']);
          authorizer.authorize(request,scopeId,'manage');
          const result=store.setEnabled(scopeId,body.enabled);
          await inputs.removeUnused(store,result.obsoleteInputs);return send(200,store.coverage(scopeId));
        });
        if(request.method==='POST' && tail==='/reindex')return await mutation(async()=>{
          const body=fields(await jsonBody(request),['model_key','force'],['model_key']);
          authorizer.authorize(request,scopeId,'manage');
          return send(202,store.reindex(scopeId,inference.model(body.model_key),body.force??false));
        });
        if(request.method==='POST' && tail==='/reindex/activate')return await mutation(async()=>{
          const body=fields(await jsonBody(request),['model_key']);
          authorizer.authorize(request,scopeId,'manage');return send(200,store.activate(scopeId,body.model_key));
        });
        if(request.method==='POST' && tail==='/models/prune')return await mutation(async()=>{
          fields(await jsonBody(request),[]);authorizer.authorize(request,scopeId,'manage');
          return send(200,store.prune(scopeId));
        });
        if(request.method==='GET' && tail==='/jobs') {
          authorizer.authorize(request,scopeId,'manage');
          return send(200,{jobs:store.listJobs(scopeId,url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50)});
        }
        const jobMatch=/^\/jobs\/(ml-index-[0-9a-f]{64})(\/retry)?$/.exec(tail);
        if(jobMatch) {
          authorizer.authorize(request,scopeId,'manage');store.scope(scopeId,false);
          const job=store.job(jobMatch[1]);
          if(!job || job.scope_id!==scopeId)throw new Failure('NOT_FOUND',404);
          if(request.method==='GET' && !jobMatch[2])return send(200,summary(job));
          if(request.method==='POST' && jobMatch[2])return await mutation(async()=>{
            const body=fields(await jsonBody(request),['retry_id']);
            authorizer.authorize(request,scopeId,'manage');return send(202,summary(store.retry(job.id,body.retry_id)));
          });
        }
        throw new Failure('NOT_FOUND',404);
      } catch(error) {
        const failure=error instanceof Failure?error:new Failure('INTERNAL',500);
        send(failure.retryable?503:failure.status,{code:failure.code,request_id:randomUUID()});
      }
    });
  server.maxConnections=32;server.maxRequestsPerSocket=100;
  server.on('clientError',(_error,socket)=>{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  server.reconcileInputs=()=>mutation(()=>inputs.reconcile(store));
  return server;
}
