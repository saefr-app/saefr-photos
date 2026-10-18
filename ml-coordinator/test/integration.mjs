import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createServer as httpServer} from 'node:http';
import {Queue} from 'bullmq';
import {Store} from '../src/lifecycle-store.mjs';
import {Inputs} from '../src/inputs.mjs';
import {Authorizer} from '../src/auth.mjs';
import {InferenceClient} from '../src/inference-client.mjs';
import {createServer} from '../src/api.mjs';
import {startWorker,reconcile} from '../src/worker.mjs';
import {Failure,modelKey} from '../src/protocol.mjs';

const owner=randomUUID();const queueName='saefr-ml-test-'+owner;
const root=mkdtempSync(join(tmpdir(),'saefr-ml-integration-'));
writeFileSync(join(root,'owner.json'),JSON.stringify({owner}),{mode:0o600});
const checksum=value=>createHash('sha256').update(value).digest('hex');
const scopes=[randomUUID(),randomUUID()];const assets=Array.from({length:6},()=>randomUUID());
const token='test-admin-'+randomUUID();const reader='test-reader-'+randomUUID();
const inferenceToken=process.env.ML_TEST_INFERENCE_TOKEN??('test-inference-'+randomUUID());
const actual=Boolean(process.env.ML_TEST_FIXTURE_DIR);
let fixtures,model,inferenceUrl,mockServer,api,worker,workerStore,store,queue;
let unblock;
const waitFor=async(condition,label)=>{
  const deadline=Date.now()+90000;
  while(!(await condition())){if(Date.now()>deadline)throw new Error('Timed out: '+label);await new Promise(r=>setTimeout(r,50));}
};
try {
  if(actual) {
    const fixtureRoot=resolve(process.env.ML_TEST_FIXTURE_DIR);
    assert.equal(JSON.parse(readFileSync(join(fixtureRoot,'owner.json'),'utf8')).kind,'saefr-synthetic-fixtures');
    fixtures=Object.fromEntries(['red','blue','green','yellow'].map(color=>[color,readFileSync(join(fixtureRoot,color+'.png'))]));
    model=JSON.parse(readFileSync(process.env.ML_TEST_REGISTRY,'utf8')).model;
    inferenceUrl=process.env.ML_TEST_INFERENCE_URL;
  } else {
    fixtures=Object.fromEntries(['red','blue','green','yellow'].map(color=>[color,Buffer.from('synthetic-'+color)]));
    model={model_id:'example/paired',revision:'1'.repeat(40),artifact_digest:'2'.repeat(64),
      preprocessing_digest:'3'.repeat(64),dimensions:3};
    mockServer=httpServer(async(req,res)=>{
      try {
        assert.equal(req.headers.authorization,'Bearer '+inferenceToken);
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const body=Buffer.concat(chunks);let metadata,vector;
        if(req.url.endsWith('/image')) {
          const form=await new Request('http://test',{method:'POST',headers:req.headers,body}).formData();
          metadata=JSON.parse(form.get('metadata'));
          vector=metadata.image.sha256===checksum(fixtures.blue)?[0,1,0]:
            metadata.image.sha256===checksum(fixtures.green)?[0,0,1]:[1,0,0];
        } else {metadata=JSON.parse(body.toString('utf8'));vector=[1,0,0];}
        const result={schema_version:'1',task:metadata.task,request_id:metadata.request_id,model,
          normalization:'l2',embedding:vector,...(metadata.task==='image_embedding'
            ?{subject:metadata.subject,image_sha256:metadata.image.sha256}:{scope_id:metadata.scope_id})};
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
      } catch {res.writeHead(500);res.end('{}');}
    });
    await new Promise(r=>mockServer.listen(0,'127.0.0.1',r));
    inferenceUrl=`http://127.0.0.1:${mockServer.address().port}`;
  }
  const port=Number(process.env.ML_TEST_REDIS_PORT);
  assert(Number.isSafeInteger(port)&&port>0&&port<65536,'Explicit isolated Redis port required');
  const host=process.env.ML_TEST_REDIS_HOST??'127.0.0.1';
  assert(['127.0.0.1','redis'].includes(host),'Only isolated local/test Redis is supported');
  const connection={host,port,maxRetriesPerRequest:null};
  queue=new Queue(queueName,{connection});queue.on('error',()=>{});await queue.waitUntilReady();
  const file=join(root,'index.sqlite');store=new Store(file);
  const inputs=new Inputs(join(root,'inputs'));await inputs.init();
  const accessFile=join(root,'access.json');
  writeFileSync(accessFile,JSON.stringify({admin_token_sha256:checksum(token),principals:[
    {token_sha256:checksum(reader),scopes:[scopes[0]],permissions:['search']}]}),{mode:0o600});
  const inference=new InferenceClient([{model,url:inferenceUrl,token:inferenceToken}]);
  api=createServer({store,inputs,inference,authorizer:new Authorizer(accessFile)});
  await new Promise(r=>api.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${api.address().port}`;
  async function call(path,{method='GET',body,raw,credential=token}={}) {
    const headers={Authorization:'Bearer '+credential};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(raw){headers['Content-Type']='image/png';headers['X-Asset-Generation']='1';}
    return fetch(base+path,{method,headers,body:raw??(body!==undefined?JSON.stringify(body):undefined)});
  }
  async function upload(scope,asset,color) {
    const response=await call(`/v1/scopes/${scope}/assets/${asset}`,{method:'PUT',raw:fixtures[color]});
    assert.equal(response.status,202,await response.clone().text());return (await response.json()).job;
  }
  const done=async job=>waitFor(()=>{
    const status=store.job(job.id);
    if(status.state==='failed')throw new Error('Unexpected terminal job failure: '+status.error_code);
    return status.state==='done';
  },'durable job');
  for(const scope of scopes)assert.equal((await call(`/v1/scopes/${scope}`,
    {method:'PUT',body:{model_key:modelKey(model)}})).status,200);
  const first=await upload(scopes[0],assets[0],'red');
  await reconcile(store,queue);assert(await queue.getJob(first.id));
  assert(queueName.startsWith('saefr-ml-test-')&&queueName.endsWith(owner));
  await queue.obliterate({force:true}); // Only this test's random namespace, never FLUSHALL.
  await reconcile(store,queue);assert(await queue.getJob(first.id));
  workerStore=new Store(file);
  worker=startWorker({store:workerStore,inputs,inference,queueName,connection,backoff:20});
  await done(first);
  const blue=await upload(scopes[0],assets[1],'blue');await reconcile(store,queue);await done(blue);
  const privateJob=await upload(scopes[1],assets[2],'red');await reconcile(store,queue);await done(privateJob);
  await worker.close();worker=null;workerStore.close();workerStore=null;
  const duplicate=await upload(scopes[0],assets[3],'red');
  workerStore=new Store(file);worker=startWorker({store:workerStore,inputs,inference,queueName,connection,backoff:20});
  await reconcile(store,queue);await done(duplicate);
  let response=await call(`/v1/scopes/${scopes[0]}/search`,{method:'POST',credential:reader,
    body:{text:'a red square on a white background'}});
  assert.equal(response.status,200);const search=await response.json();
  assert(search.results.slice(0,2).every(result=>[assets[0],assets[3]].includes(result.asset_id)));
  assert(!search.results.some(result=>result.asset_id===assets[2]));
  assert.equal((await call(`/v1/scopes/${scopes[1]}/search`,{method:'POST',credential:reader,
    body:{text:'shape'}})).status,404);
  response=await call(`/v1/scopes/${scopes[0]}/duplicates`,{method:'POST',credential:reader,
    body:{asset_ids:[assets[0],assets[3]]}});
  assert.equal((await response.json()).groups[0].kind,'exact');
  const originalPredict=inference.predict.bind(inference);let transient=true;
  inference.predict=async(request,content)=>{
    if(transient&&request.image.sha256===checksum(fixtures.green)) {
      transient=false;throw new Failure('INFERENCE_UNAVAILABLE',502,true);
    }
    return originalPredict(request,content);
  };
  const retry=await upload(scopes[0],assets[4],'green');await reconcile(store,queue);await done(retry);
  assert.equal(store.job(retry.id).attempts,2);
  let started;const beginning=new Promise(resolve=>started=resolve);
  inference.predict=async(request,content)=>{
    if(request.image.sha256===checksum(fixtures.yellow)) {
      started();await new Promise(resolve=>unblock=resolve);
    }
    return originalPredict(request,content);
  };
  const late=await upload(scopes[0],assets[5],'yellow');await reconcile(store,queue);await beginning;
  response=await call(`/v1/scopes/${scopes[0]}/settings`,{method:'PATCH',body:{enabled:false}});
  assert.equal(response.status,200);unblock();unblock=null;
  await waitFor(()=>store.job(late.id).state==='skipped','late result rejected');
  await worker.close();worker=null;
  assert.equal(store.rows(scopes[0],modelKey(model)).length,0);
  assert.equal(store.job(late.id).request_json,null);
  assert.equal(store.rows(scopes[1],modelKey(model)).length,1);
  for(const id of [assets[0],assets[1],assets[3],assets[4],assets[5]])
    assert.equal(store.asset(scopes[0],id,false).input_key,null);
  const evidence={mode:actual?'real CLIP container':'mock inference; real Redis/BullMQ',
    dimensions:model.dimensions,scope_isolation:true,semantic_ranking:true,duplicate_suggestions:true,
    lost_queue_recovered:true,worker_restarted:true,bounded_retry_attempts:store.job(retry.id).attempts,
    late_result_rejected:true,disabled_scope_purged:true,other_scope_preserved:true};
  if(process.env.ML_TEST_EVIDENCE)writeFileSync(process.env.ML_TEST_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
} finally {
  if(unblock)unblock();if(worker)await worker.close();
  workerStore?.close();if(api){api.closeAllConnections();await new Promise(r=>api.close(r));}
  if(queue){assert(queueName.endsWith(owner));await queue.obliterate({force:true});await queue.close();}
  store?.close();if(mockServer){mockServer.closeAllConnections();await new Promise(r=>mockServer.close(r));}
  const target=resolve(root);
  assert.equal(dirname(target),resolve(tmpdir()));assert(target.includes('saefr-ml-integration-'));
  assert.equal(JSON.parse(readFileSync(join(target,'owner.json'),'utf8')).owner,owner);
  rmSync(target,{recursive:true,force:true});
}
