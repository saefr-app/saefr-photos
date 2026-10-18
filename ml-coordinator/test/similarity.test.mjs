import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {IndexStore} from '../src/index-store.mjs';
import {similar,duplicateSuggestions} from '../src/similarity.mjs';
import {scopeA,scopeB,assetA,assetB,assetC,model,image,request,temporary} from './helpers.mjs';

function fixture(t) {
  let store; t.after(()=>store?.close());
  store=new IndexStore(join(temporary(t),'index.sqlite'));
  store.createScope(scopeA,model); store.createScope(scopeB,model);
  for (const [id,angle,digest] of [[assetA,0,'a'],[assetB,0.1,'b'],[assetC,0.2,'c']]) {
    const descriptor={...image,sha256:digest.repeat(64)};
    store.register(scopeA,id,1,descriptor,digest.repeat(64));
    store.publish({...request(scopeA,id),image:descriptor},[Math.cos(angle),Math.sin(angle),0],1);
  }
  return store;
}
test('similar photos exclude the source and respect scope',t=>{
  const store=fixture(t);
  assert.equal(similar(store,scopeA,assetA).results[0].asset_id,assetB);
  assert.throws(()=>similar(store,scopeB,assetA),error=>error.status===404);
});
test('near duplicate suggestions do not merge transitive chains or delete anything',t=>{
  const store=fixture(t);
  const result=duplicateSuggestions(store,scopeA,[assetA,assetB,assetC],Math.cos(0.15));
  assert.deepEqual(result.groups.map(group=>group.asset_ids),[[assetA,assetB]]);
  assert.equal(result.suggestions_only,true);
  assert.equal(store.rows(scopeA,store.scope(scopeA).active_model).length,3);
  assert.throws(()=>duplicateSuggestions(store,scopeA,[assetA,assetA]));
  assert.throws(()=>duplicateSuggestions(store,scopeA,[assetA,assetB],0.5));
});
