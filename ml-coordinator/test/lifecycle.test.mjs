import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Store} from '../src/lifecycle-store.mjs';
import {processIndex} from '../src/worker.mjs';
import {modelKey} from '../src/protocol.mjs';
import {scopeA,scopeB,assetA,assetB,model,image,temporary} from './helpers.mjs';

function fixture(t) {
  const stores=[]; t.after(()=>stores.forEach(store=>store.close()));
  const file=join(temporary(t),'index.sqlite');
  const store=new Store(file);stores.push(store);
  store.createScope(scopeA,model);store.createScope(scopeB,model);
  return {store,file,stores};
}
test('delete in another connection rejects an in-flight late result atomically',async t=>{
  const {store,file,stores}=fixture(t);
  const job=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  let release,started;
  const beginning=new Promise(resolve=>started=resolve);
  const processing=processIndex(store,{read:async()=>Buffer.from('synthetic')},
    {predict:async()=>{started();return new Promise(resolve=>release=resolve);}},job.id);
  await beginning;
  const other=new Store(file);stores.push(other);
  other.lifecycle(scopeA,assetA,2,'deleted');
  release([1,0,0]); await processing;
  assert.equal(store.job(job.id).state,'skipped');
  assert.equal(store.rows(scopeA,modelKey(model)).length,0);
  assert.equal(store.job(job.id).request_json,null);
  assert.throws(()=>store.registerAndQueue(scopeA,assetA,3,image,'6'.repeat(64)));
});
test('trash/restore ignores out-of-order events and requires fresh input',t=>{
  const {store}=fixture(t);
  const old=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  const claim=store.claim(old.id);
  store.lifecycle(scopeA,assetA,2,'trashed');store.lifecycle(scopeA,assetA,3,'eligible');
  assert.equal(store.lifecycle(scopeA,assetA,2,'trashed').applied,false);
  assert.equal(store.asset(scopeA,assetA).input_key,null);
  assert.equal(store.finish(old.id,claim.request,[1,0,0]),false);
  const fresh=store.registerAndQueue(scopeA,assetA,3,image,'6'.repeat(64)).job;
  const attempt=store.claim(fresh.id);assert.equal(store.finish(fresh.id,attempt.request,[1,0,0]),true);
});
test('ML disable purges derived records and blocks old jobs after re-enable',t=>{
  const {store}=fixture(t);
  const job=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  const attempt=store.claim(job.id);
  assert.deepEqual(store.setEnabled(scopeA,false).obsoleteInputs,['5'.repeat(64)]);
  assert.throws(()=>store.search(scopeA,modelKey(model),[1,0,0]));
  store.setEnabled(scopeA,true);
  assert.equal(store.finish(job.id,attempt.request,[1,0,0]),false);
  assert.equal(store.asset(scopeA,assetA).checksum,null);
  assert.equal(store.coverage(scopeA).indexed,0);
});
test('model upgrade keeps old search until complete and switches image/query identity together',t=>{
  const {store}=fixture(t);
  for(const asset of [assetA,assetB]) {
    const job=store.registerAndQueue(scopeA,asset,1,image,asset===assetA?'5'.repeat(64):'6'.repeat(64)).job;
    const attempt=store.claim(job.id);store.finish(job.id,attempt.request,[1,0,0]);
  }
  const newer={...model,revision:'a'.repeat(40),artifact_digest:'b'.repeat(64)};
  store.reindex(scopeA,newer);
  assert.equal(store.search(scopeA,modelKey(model),[1,0,0]).results.length,2);
  const ids=store.recoverable();
  const first=store.claim(ids[0]);store.finish(ids[0],first.request,[0,1,0]);
  assert.throws(()=>store.activate(scopeA,modelKey(newer)));
  const second=store.claim(ids[1]);store.finish(ids[1],second.request,[0,1,0]);
  store.activate(scopeA,modelKey(newer));
  assert.throws(()=>store.search(scopeA,modelKey(model),[1,0,0]));
  assert.equal(store.search(scopeA,modelKey(newer),[0,1,0]).results.length,2);
  store.prune(scopeA);assert.equal(store.rows(scopeA,modelKey(model)).length,0);
});
test('scope move removes old-scope visibility and requires new-scope input',t=>{
  const {store}=fixture(t);
  const job=store.registerAndQueue(scopeA,assetA,1,image,'5'.repeat(64)).job;
  const attempt=store.claim(job.id);store.finish(job.id,attempt.request,[1,0,0]);
  store.move(scopeA,assetA,scopeB,2);
  assert.throws(()=>store.asset(scopeA,assetA));
  assert.equal(store.asset(scopeB,assetA).input_key,null);
  assert.equal(store.rows(scopeA,modelKey(model)).length,0);
});
