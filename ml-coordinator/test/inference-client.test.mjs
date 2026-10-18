import test from 'node:test';
import assert from 'node:assert/strict';
import {InferenceClient} from '../src/inference-client.mjs';
import {model,request} from './helpers.mjs';

const route={model,url:'http://127.0.0.1:8001',token:'test-inference-token-'.repeat(2)};
test('inference results are bound to model, content and request before use',async()=>{
  const input=request();
  const result={schema_version:'1',task:'image_embedding',request_id:input.request_id,
    subject:input.subject,model,normalization:'l2',image_sha256:input.image.sha256,embedding:[1,0,0]};
  const client=new InferenceClient([route],{fetcher:async()=>new Response(JSON.stringify(result))});
  assert.deepEqual(await client.predict(input,Buffer.from('example')),[1,0,0]);
  result.image_sha256='a'.repeat(64);
  await assert.rejects(()=>client.predict(input,Buffer.from('example')),error=>error.code==='PROTOCOL_MISMATCH');
});
test('transient failures retry while protocol and permanent failures do not',async()=>{
  const client=new InferenceClient([route],{fetcher:async()=>new Response('{}',{status:503})});
  await assert.rejects(()=>client.predict(request(),Buffer.from('example')),error=>error.retryable===true);
  client.fetcher=async()=>new Response('{}',{status:422});
  await assert.rejects(()=>client.predict(request(),Buffer.from('example')),error=>error.retryable===false);
  client.fetcher=async()=>new Response('x'.repeat(256*1024+1));
  await assert.rejects(()=>client.predict(request(),Buffer.from('example')),error=>error.code==='PROTOCOL_MISMATCH');
});
