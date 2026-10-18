import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {JobsStore} from '../src/jobs-store.mjs';
import {processIndex,reconcile} from '../src/worker.mjs';
import {Failure} from '../src/protocol.mjs';
import {scopeA,assetA,assetB,model,image,temporary} from './helpers.mjs';

function fixture(t) {
  let store; t.after(()=>store?.close());
  const file=join(temporary(t),'index.sqlite');
  store=new JobsStore(file); store.createScope(scopeA,model);
  return {store,file};
}
test('jobs persist, duplicate submits share identity and scope-local bytes reuse inference',async t=>{
  const {store}=fixture(t);
  const first=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  assert.equal(store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job.id,first.id);
  let calls=0;
  const client={predict:async()=>{calls++;return [1,0,0];}};
  const inputs={read:async()=>Buffer.from('synthetic')};
  assert.equal((await processIndex(store,inputs,client,first.id)).accepted,true);
  const second=store.registerAndQueue(scopeA,assetB,1,image,'6'.repeat(64)).job;
  await processIndex(store,inputs,client,second.id);
  assert.equal(calls,1);
  assert.equal(store.job(first.id).state,'done');
  assert.equal(store.job(second.id).state,'done');
});
test('recovery republishes lost Redis jobs without resetting the durable retry budget',async t=>{
  const {store}=fixture(t);
  const job=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  const added=[];const queue={getJob:async()=>null,add:async(...args)=>added.push(args)};
  await reconcile(store,queue); assert.equal(added[0][2].jobId,job.id);
  const client={predict:async()=>{throw new Failure('INFERENCE_UNAVAILABLE',502,true);}};
  const inputs={read:async()=>Buffer.from('synthetic')};
  for(let attempt=1;attempt<=3;attempt++) {
    await assert.rejects(()=>processIndex(store,inputs,client,job.id));
    assert.equal(store.job(job.id).attempts,attempt);
  }
  assert.equal(store.job(job.id).state,'failed');
  await processIndex(store,inputs,client,job.id);
  assert.equal(store.job(job.id).attempts,3);
});
test('permanent protocol errors fail once and metadata is never copied into errors',async t=>{
  const {store}=fixture(t);
  const job=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  await assert.rejects(()=>processIndex(store,{read:async()=>Buffer.from('synthetic')},
    {predict:async()=>{throw new Error('/private/original secret');}},job.id));
  assert.equal(store.job(job.id).state,'failed');
  assert.equal(store.job(job.id).attempts,1);
  assert.equal(store.job(job.id).error_code,'PROCESSING_FAILED');
});
