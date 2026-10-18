import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Store} from '../src/lifecycle-store.mjs';
import {processIndex} from '../src/worker.mjs';
import {Failure} from '../src/protocol.mjs';
import {scopeA,assetA,model,image,temporary} from './helpers.mjs';

test('missing input cache is visible, requests resupply, and repairs without resetting inference failures',async t=>{
  let store;t.after(()=>store?.close());store=new Store(join(temporary(t),'index.sqlite'));
  store.createScope(scopeA,model);
  const job=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  await assert.rejects(()=>processIndex(store,{read:async()=>{throw new Failure('SOURCE_UNAVAILABLE',503);}},
    {predict:async()=>[1,0,0]},job.id));
  assert.equal(store.job(job.id).state,'failed');assert.equal(store.assetStatus(scopeA,assetA).needs_input,true);
  const repaired=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  assert.equal(repaired.state,'pending');assert.equal(repaired.attempts,0);
  await processIndex(store,{read:async()=>Buffer.from('synthetic')},{predict:async()=>[1,0,0]},job.id);
  assert.equal(store.assetStatus(scopeA,assetA).indexed,true);
});
