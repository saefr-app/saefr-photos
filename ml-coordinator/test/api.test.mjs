import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../src/lifecycle-store.mjs';
import {Inputs} from '../src/inputs.mjs';
import {Authorizer} from '../src/auth.mjs';
import {createServer} from '../src/api.mjs';
import {processIndex} from '../src/worker.mjs';
import {modelKey,Failure} from '../src/protocol.mjs';
import {scopeA,scopeB,assetA,assetB,model,temporary} from './helpers.mjs';

const admin='test-admin-token-for-local-unit-tests-0000';
const readerA='test-reader-a-for-local-unit-tests-0000000';
const readerB='test-reader-b-for-local-unit-tests-0000000';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  let server,store;
  t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}store?.close();});
  const root=temporary(t);const accessFile=join(root,'access.json');
  const config={admin_token_sha256:hash(admin),principals:[
    {token_sha256:hash(readerA),scopes:[scopeA],permissions:['search']},
    {token_sha256:hash(readerB),scopes:[scopeB],permissions:['search']}]};
  const saveAccess=()=>writeFileSync(accessFile,JSON.stringify(config),{mode:0o600});saveAccess();
  store=new Store(join(root,'index.sqlite'));
  const inputs=new Inputs(join(root,'inputs'));await inputs.init();
  const inference={model:key=>{if(key!==modelKey(model))throw new Failure('MODEL_MISMATCH',409);return model;},
    predict:async()=>[1,0,0],searchVector:async()=>[1,0,0]};
  server=createServer({store,inputs,inference,authorizer:new Authorizer(accessFile)});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,{token=admin,method='GET',body,raw,generation=1}={}) {
    const headers={Authorization:'Bearer '+token};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(raw!==undefined){headers['Content-Type']='image/png';headers['X-Asset-Generation']=String(generation);}
    return fetch(base+path,{method,headers,body:raw??(body!==undefined?JSON.stringify(body):undefined)});
  }
  for(const scope of [scopeA,scopeB])assert.equal((await call(`/v1/scopes/${scope}`,
    {method:'PUT',body:{model_key:modelKey(model)}})).status,200);
  return {root,store,inputs,inference,call,config,saveAccess};
}
async function upload(f,scope=scopeA,asset=assetA,generation=1,bytes=Buffer.from('synthetic-test-bytes')) {
  const response=await f.call(`/v1/scopes/${scope}/assets/${asset}`,{method:'PUT',raw:bytes,generation});
  assert.equal(response.status,202,await response.clone().text());
  return response.json();
}
async function process(f,job) {await processIndex(f.store,f.inputs,f.inference,job.id);}

test('HTTP upload -> index -> scoped semantic search and exact duplicate suggestions',async t=>{
  const f=await fixture(t);
  const first=await upload(f);await process(f,first.job);
  const second=await upload(f,scopeA,assetB);await process(f,second.job);
  let response=await f.call(`/v1/scopes/${scopeA}/search`,{method:'POST',token:readerA,body:{text:'a shape'}});
  assert.equal(response.status,200);assert.equal((await response.json()).results.length,2);
  assert.equal((await f.call(`/v1/scopes/${scopeB}/search`,{method:'POST',token:readerA,body:{text:'a shape'}})).status,404);
  assert.equal((await f.call(`/v1/scopes/${scopeA}/jobs`,{token:readerA})).status,404);
  response=await f.call(`/v1/scopes/${scopeA}/duplicates`,{method:'POST',token:readerA,
    body:{asset_ids:[assetA,assetB]}});
  const duplicates=await response.json();assert.equal(duplicates.groups[0].kind,'exact');
  assert.equal(duplicates.suggestions_only,true);
  response=await f.call(`/v1/scopes/${scopeA}/assets/${assetA}/similar`,{token:readerA});
  assert.equal((await response.json()).results[0].asset_id,assetB);
  assert.equal(f.store.asset(scopeA,assetA).state,'eligible');
});
test('permission revocation during inference prevents returning results',async t=>{
  const f=await fixture(t);const first=await upload(f);await process(f,first.job);
  let release,started;const beginning=new Promise(resolve=>started=resolve);
  f.inference.searchVector=async()=>{started();return new Promise(resolve=>release=resolve);};
  const pending=f.call(`/v1/scopes/${scopeA}/search`,{method:'POST',token:readerA,body:{text:'a shape'}});
  await beginning;f.config.principals[0].scopes=[];f.saveAccess();release([1,0,0]);
  assert.equal((await pending).status,404);
});
test('disable and deletion remove input copies, vectors and sensitive job payloads',async t=>{
  const f=await fixture(t);const first=await upload(f);await process(f,first.job);
  const inputPath=f.inputs.path(f.store.asset(scopeA,assetA).input_key);
  assert.equal(existsSync(inputPath),true);
  let response=await f.call(`/v1/scopes/${scopeA}/settings`,{method:'PATCH',body:{enabled:false}});
  assert.equal(response.status,200);assert.equal(existsSync(inputPath),false);
  assert.equal(f.store.rows(scopeA,modelKey(model)).length,0);
  assert.equal(f.store.job(first.job.id).request_json,null);
  assert.equal((await f.call(`/v1/scopes/${scopeA}/search`,{method:'POST',token:readerA,body:{text:'shape'}})).status,404);
  await f.call(`/v1/scopes/${scopeA}/settings`,{method:'PATCH',body:{enabled:true}});
  const next=await upload(f);await process(f,next.job);
  response=await f.call(`/v1/scopes/${scopeA}/assets/${assetA}/lifecycle`,
    {method:'POST',body:{generation:2,state:'deleted'}});
  assert.equal(response.status,200);
  assert.equal(readdirSync(join(f.root,'inputs')).filter(name=>name.endsWith('.blob')).length,0);
  assert.equal((await f.call(`/v1/scopes/${scopeA}/assets/${assetA}`,{method:'PUT',raw:Buffer.from('new'),generation:3})).status,409);
});
test('failed jobs are visible and an explicit idempotent retry gets a new bounded budget',async t=>{
  const f=await fixture(t);const first=await upload(f);
  f.inference.predict=async()=>{throw new Failure('INFERENCE_REJECTED',502);};
  await assert.rejects(()=>process(f,first.job));
  let response=await f.call(`/v1/scopes/${scopeA}/jobs/${first.job.id}`);
  assert.equal((await response.json()).state,'failed');
  const retryId=randomUUID();
  response=await f.call(`/v1/scopes/${scopeA}/jobs/${first.job.id}/retry`,
    {method:'POST',body:{retry_id:retryId}});
  assert.equal(response.status,202);const retry=await response.json();
  assert.notEqual(retry.id,first.job.id);f.inference.predict=async()=>[1,0,0];await process(f,retry);
  const same=await f.call(`/v1/scopes/${scopeA}/jobs/${first.job.id}/retry`,{method:'POST',body:{retry_id:retryId}});
  assert.equal((await same.json()).id,retry.id);
});
