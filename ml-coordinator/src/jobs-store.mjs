import {randomUUID} from 'node:crypto';
import {IndexStore} from './index-store.mjs';
import {digest, validate, Failure, identifier, integer} from './protocol.mjs';

export class JobsStore extends IndexStore {
  queueInside(asset) {
    if (!asset.input_key || asset.state !== 'eligible') return null;
    const scope=this.scope(asset.scope_id);
    const model=this.model(scope.target_model);
    const request={schema_version:'1',task:'image_embedding',request_id:randomUUID(),
      subject:{scope_id:asset.scope_id,asset_id:asset.id,generation:asset.generation},model,
      image:{sha256:asset.checksum,byte_size:asset.byte_size,media_type:asset.media_type}};
    validate('image-request',request);
    const {request_id:_,...identity}=request;
    const id='ml-index-'+digest({request:identity,epoch:scope.epoch});
    const existing=this.db.prepare(`SELECT 1 FROM embeddings WHERE asset_id=? AND model_key=?
      AND scope_id=? AND generation=? AND checksum=?`)
      .get(asset.id,scope.target_model,scope.id,asset.generation,asset.checksum);
    this.db.prepare(`INSERT OR IGNORE INTO jobs(id,asset_id,scope_id,generation,epoch,model_key,
      request_json,state,attempts,error_code,updated_at) VALUES (?,?,?,?,?,?,?,?,0,NULL,?)`)
      .run(id,asset.id,scope.id,asset.generation,scope.epoch,scope.target_model,
        JSON.stringify(request),existing?'done':'pending',Date.now());
    return this.job(id);
  }
  registerAndQueue(scopeId,assetId,generation,image,inputKey) {
    return this.transaction(()=>{
      const registered=this.registerInside(scopeId,assetId,generation,image,inputKey);
      const job=this.queueInside(registered.asset);
      if(job?.state==='failed' && job.error_code==='SOURCE_UNAVAILABLE') {
        this.db.prepare("UPDATE jobs SET state='pending',attempts=0,error_code=NULL,updated_at=? WHERE id=?")
          .run(Date.now(),job.id);
      }
      return {...registered,job:job?this.job(job.id):null};
    });
  }
  job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  recoverable(limit=100) {
    return this.db.prepare("SELECT id FROM jobs WHERE state IN ('pending','running') ORDER BY updated_at LIMIT ?")
      .all(limit).map(row=>row.id);
  }
  eligibleJob(job) {
    const scope=this.db.prepare('SELECT * FROM scopes WHERE id=?').get(job.scope_id);
    const asset=this.db.prepare('SELECT * FROM assets WHERE id=?').get(job.asset_id);
    return Boolean(scope?.enabled && scope.epoch===job.epoch && scope.target_model===job.model_key
      && asset?.state==='eligible' && asset.scope_id===scope.id && asset.generation===job.generation
      && asset.input_key && job.request_json && asset.checksum===JSON.parse(job.request_json).image.sha256);
  }
  claim(id) {
    return this.transaction(()=>{
      const job=this.job(id);
      if (!job || !['pending','running'].includes(job.state)) return null;
      if (!this.eligibleJob(job)) {
        this.db.prepare("UPDATE jobs SET state='skipped',request_json=NULL,updated_at=? WHERE id=?").run(Date.now(),id);
        return null;
      }
      if (job.attempts>=3) {
        this.db.prepare("UPDATE jobs SET state='failed',error_code='RETRY_EXHAUSTED',updated_at=? WHERE id=?")
          .run(Date.now(),id);
        return null;
      }
      this.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1,updated_at=? WHERE id=?").run(Date.now(),id);
      const request={...JSON.parse(job.request_json),request_id:randomUUID()};
      const asset=this.asset(job.scope_id,job.asset_id);
      return {...job,attempts:job.attempts+1,request,input_key:asset.input_key};
    });
  }
  reusable(job) {
    const row=this.db.prepare(`SELECT e.vector FROM embeddings e JOIN assets a ON a.id=e.asset_id
      WHERE e.scope_id=? AND a.scope_id=? AND e.model_key=? AND e.checksum=? AND a.state='eligible'
      AND a.generation=e.generation AND a.checksum=e.checksum LIMIT 1`)
      .get(job.scope_id,job.scope_id,job.model_key,job.request.image.sha256);
    return row?JSON.parse(row.vector):null;
  }
  finish(id,request,vector) {
    return this.transaction(()=>{
      const job=this.job(id);
      if (!job || job.state!=='running') return false;
      const original=JSON.parse(job.request_json);
      const {request_id:ignoredOriginal,...expected}=original;
      const {request_id:ignoredAttempt,...actual}=request;
      if (digest(expected)!==digest(actual)) throw new Failure('PROTOCOL_MISMATCH',502);
      const accepted=this.eligibleJob(job) && this.publishInside(request,vector,job.epoch);
      this.db.prepare('UPDATE jobs SET state=?,error_code=NULL,updated_at=? WHERE id=?')
        .run(accepted?'done':'skipped',Date.now(),id);
      return accepted;
    });
  }
  fail(id,code,retryable) {
    return this.transaction(()=>{
      const job=this.job(id);
      if (!job || job.state!=='running') return false;
      const eligible=this.eligibleJob(job);
      const retry=eligible && retryable && job.attempts<3;
      this.db.prepare('UPDATE jobs SET state=?,error_code=?,updated_at=? WHERE id=?')
        .run(!eligible?'skipped':retry?'pending':'failed',eligible?code:null,Date.now(),id);
      return retry;
    });
  }
  lostInput(id) {
    return this.transaction(()=>{
      const job=this.job(id);
      if(!job || job.state!=='running')return;
      if(!this.eligibleJob(job)) {
        this.db.prepare("UPDATE jobs SET state='skipped',request_json=NULL,error_code=NULL,updated_at=? WHERE id=?")
          .run(Date.now(),id);return;
      }
      this.db.prepare('UPDATE assets SET input_key=NULL WHERE id=? AND generation=?').run(job.asset_id,job.generation);
      this.db.prepare("UPDATE jobs SET state='failed',error_code='SOURCE_UNAVAILABLE',updated_at=? WHERE id=?")
        .run(Date.now(),id);
    });
  }
  coverage(scopeId) {
    const scope=this.scope(scopeId,false);
    const count=this.db.prepare(`SELECT count(*) AS total,count(e.asset_id) AS indexed FROM assets a
      LEFT JOIN embeddings e ON e.asset_id=a.id AND e.scope_id=a.scope_id AND e.model_key=?
      AND e.generation=a.generation AND e.checksum=a.checksum WHERE a.scope_id=? AND a.state='eligible'`)
      .get(scope.target_model,scopeId);
    const jobs=Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM jobs WHERE scope_id=? AND epoch=? GROUP BY state')
      .all(scopeId,scope.epoch).map(row=>[row.state,row.n]));
    return {enabled:Boolean(scope.enabled),active_model:scope.active_model,target_model:scope.target_model,
      epoch:scope.epoch,...count,jobs};
  }
  listJobs(scopeId,limit=50) {
    this.scope(scopeId,false);integer(limit,1,100);
    return this.db.prepare(`SELECT id,state,attempts,error_code,model_key,updated_at FROM jobs
      WHERE scope_id=? ORDER BY updated_at DESC,id LIMIT ?`).all(scopeId,limit);
  }
  assetStatus(scopeId,assetId) {
    const asset=this.asset(scopeId,assetId,false);const scope=this.scope(scopeId,false);
    const indexed=Boolean(this.db.prepare(`SELECT 1 FROM embeddings WHERE asset_id=? AND scope_id=?
      AND model_key=? AND generation=? AND checksum=?`).get(assetId,scopeId,scope.target_model,asset.generation,asset.checksum));
    return {asset_id:assetId,generation:asset.generation,state:asset.state,needs_input:asset.input_key===null,indexed};
  }
  retry(id,retryId) {
    identifier(retryId);
    return this.transaction(()=>{
      const original=this.job(id);
      if (!original || original.state!=='failed' || !this.eligibleJob(original))
        throw new Failure('JOB_NOT_RETRYABLE',409);
      const next='ml-index-'+digest({previous:id,retry_id:retryId});
      this.db.prepare(`INSERT OR IGNORE INTO jobs(id,asset_id,scope_id,generation,epoch,model_key,
        request_json,state,attempts,error_code,updated_at) VALUES (?,?,?,?,?,?,?,'pending',0,NULL,?)`)
        .run(next,original.asset_id,original.scope_id,original.generation,original.epoch,
          original.model_key,original.request_json,Date.now());
      return this.job(next);
    });
  }
}
