import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export const scopeA='00000000-0000-4000-8000-000000000001';
export const scopeB='00000000-0000-4000-8000-000000000002';
export const assetA='00000000-0000-4000-8000-000000000011';
export const assetB='00000000-0000-4000-8000-000000000012';
export const assetC='00000000-0000-4000-8000-000000000013';
export const model={model_id:'example/paired',revision:'1'.repeat(40),artifact_digest:'2'.repeat(64),
  preprocessing_digest:'3'.repeat(64),dimensions:3};
export const image={sha256:'4'.repeat(64),byte_size:10,media_type:'image/png'};
export function request(scope=scopeA,asset=assetA,generation=1,selected=model) {
  return {schema_version:'1',task:'image_embedding',request_id:randomUUID(),
    subject:{scope_id:scope,asset_id:asset,generation},model:selected,image};
}
export function temporary(test) {
  const root=mkdtempSync(join(tmpdir(),'saefr-ml-test-'));
  test.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}
