import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Store} from '../src/lifecycle-store.mjs';
import {acquireApiLease} from '../src/runtime.mjs';
import {temporary,scopeA,model} from './helpers.mjs';

test('single API lease fences stale writers across process/container identity changes',async t=>{
  const stores=[];const releases=[];t.after(()=>{releases.forEach(release=>release());stores.forEach(store=>store.close());});
  const file=join(temporary(t),'index.sqlite');
  const first=new Store(file),second=new Store(file);stores.push(first,second);
  const release=await acquireApiLease(first,()=>{},{ttl:1000,wait:0});releases.push(release);
  await assert.rejects(()=>acquireApiLease(second,()=>{},{ttl:1000,wait:0}),error=>error.code==='API_ALREADY_RUNNING');
  second.db.prepare('UPDATE api_lease SET owner=?,expires_at=? WHERE id=1').run('new-owner',Date.now()+1000);
  assert.throws(()=>first.createScope(scopeA,model),error=>error.code==='API_LEASE_LOST');
});
test('expired leases allow restart without trusting reused OS PIDs',async t=>{
  const stores=[];const releases=[];t.after(()=>{releases.forEach(release=>release());stores.forEach(store=>store.close());});
  const file=join(temporary(t),'index.sqlite');const store=new Store(file);stores.push(store);
  store.db.prepare('INSERT INTO api_lease VALUES (1,?,?)').run('dead-instance',Date.now()-1000);
  releases.push(await acquireApiLease(store,()=>{},{ttl:1000,wait:0}));
  assert.equal(store.createScope(scopeA,model).id,scopeA);
});
