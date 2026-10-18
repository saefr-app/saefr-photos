import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {IndexStore} from '../src/index-store.mjs';
import {modelKey, unit} from '../src/protocol.mjs';
import {assetA,assetB,assetC,scopeA,scopeB,model,image,request,temporary} from './helpers.mjs';

test('semantic vectors rank, filter scopes and survive a restart', t=>{
  let store; t.after(()=>store?.close());
  const file=join(temporary(t),'index.sqlite');
  store=new IndexStore(file);
  const key=modelKey(model);
  store.createScope(scopeA,model); store.createScope(scopeB,model);
  for (const [scope,id,vector] of [[scopeA,assetA,[1,0,0]],[scopeA,assetB,[0,1,0]],[scopeB,assetC,[1,0,0]]]) {
    store.register(scope,id,1,image,'5'.repeat(64));
    assert.equal(store.publish(request(scope,id),vector,1),true);
  }
  assert.deepEqual(store.search(scopeA,key,[1,0,0]).results.map(r=>r.asset_id),[assetA,assetB]);
  assert.deepEqual(store.search(scopeA,key,[1,0,0],{minScore:0.5}).results.map(r=>r.asset_id),[assetA]);
  store.close(); store=new IndexStore(file);
  assert.equal(store.search(scopeB,key,[1,0,0]).results.length,1);
  assert.equal(store.search(scopeB,key,[1,0,0]).results[0].asset_id,assetC);
});
test('generation CAS rejects stale content and hides obsolete vectors',t=>{
  let store; t.after(()=>store?.close());
  store=new IndexStore(join(temporary(t),'index.sqlite'));
  store.createScope(scopeA,model); store.register(scopeA,assetA,1,image,'5'.repeat(64));
  assert.equal(store.publish(request(),[1,0,0],1),true);
  store.register(scopeA,assetA,2,{...image,sha256:'a'.repeat(64)},'6'.repeat(64));
  assert.equal(store.publish(request(),[1,0,0],1),false);
  assert.deepEqual(store.search(scopeA,modelKey(model),[1,0,0]).results,[]);
  assert.throws(()=>store.register(scopeA,assetA,1,image,'5'.repeat(64)));
});
test('scope quotas and vector invariants fail closed',t=>{
  let store; t.after(()=>store?.close());
  store=new IndexStore(join(temporary(t),'index.sqlite'),{maxAssets:1,maxBytes:20});
  store.createScope(scopeA,model);
  store.register(scopeA,assetA,1,image,'5'.repeat(64));
  assert.throws(()=>store.register(scopeA,assetB,1,image,'6'.repeat(64)));
  for (const vector of [[0,0,0],[NaN,0,0],[1,0],[Infinity,0,0]]) assert.throws(()=>unit(vector,3));
  assert.throws(()=>store.search(scopeA,modelKey(model),[1,0,0],{limit:1000}));
});
