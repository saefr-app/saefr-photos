import {JobsStore} from './jobs-store.mjs';
import {Failure, integer, modelKey} from './protocol.mjs';

export class Store extends JobsStore {
  purgeAssetInside(assetId) {
    this.db.prepare('DELETE FROM embeddings WHERE asset_id=?').run(assetId);
    this.db.prepare("UPDATE jobs SET state='skipped',request_json=NULL,error_code=NULL,updated_at=? WHERE asset_id=?")
      .run(Date.now(),assetId);
    this.db.prepare('UPDATE assets SET input_key=NULL,checksum=NULL,byte_size=NULL,media_type=NULL WHERE id=?').run(assetId);
  }
  lifecycle(scopeId,assetId,generation,state) {
    integer(generation);
    if (!['eligible','trashed','deleted'].includes(state)) throw new Failure('INVALID_REQUEST');
    return this.transaction(()=>{
      const asset=this.asset(scopeId,assetId,false);
      if (generation<asset.generation || (generation===asset.generation && state===asset.state))
        return {applied:false,obsoleteInputs:[]};
      if (generation===asset.generation || (asset.state==='deleted' && state!=='deleted')
          || (state==='eligible' && asset.state!=='trashed')) throw new Failure('INVALID_TRANSITION',409);
      this.purgeAssetInside(assetId);
      this.db.prepare('UPDATE assets SET generation=?,state=? WHERE id=?').run(generation,state,assetId);
      return {applied:true,obsoleteInputs:asset.input_key?[asset.input_key]:[]};
    });
  }
  setEnabled(scopeId,enabled) {
    if (typeof enabled!=='boolean') throw new Failure('INVALID_REQUEST');
    return this.transaction(()=>{
      const scope=this.scope(scopeId,false);
      if (Boolean(scope.enabled)===enabled) return {applied:false,obsoleteInputs:[]};
      const assets=this.db.prepare('SELECT * FROM assets WHERE scope_id=?').all(scopeId);
      this.db.prepare('UPDATE scopes SET enabled=?,epoch=epoch+1 WHERE id=?').run(enabled?1:0,scopeId);
      if (!enabled) for (const asset of assets) this.purgeAssetInside(asset.id);
      return {applied:true,obsoleteInputs:enabled?[]:assets.map(a=>a.input_key).filter(Boolean)};
    });
  }
  move(scopeId,assetId,destination,generation) {
    integer(generation);
    return this.transaction(()=>{
      const asset=this.asset(scopeId,assetId,false); this.scope(destination);
      if (destination===scopeId || asset.state==='deleted' || generation<=asset.generation)
        throw new Failure('INVALID_TRANSITION',409);
      const n=this.db.prepare("SELECT count(*) AS n FROM assets WHERE scope_id=?").get(destination).n;
      if (n>=this.maxAssets) throw new Failure('SCOPE_LIMIT',413);
      this.purgeAssetInside(assetId);
      this.db.prepare("UPDATE assets SET scope_id=?,generation=?,state='eligible' WHERE id=?")
        .run(destination,generation,assetId);
      return {applied:true,obsoleteInputs:asset.input_key?[asset.input_key]:[]};
    });
  }
  reindex(scopeId,model,force=false) {
    if (typeof force!=='boolean') throw new Failure('INVALID_REQUEST');
    const key=modelKey(model);
    return this.transaction(()=>{
      const scope=this.scope(scopeId);
      this.db.prepare('INSERT OR IGNORE INTO models VALUES (?,?)').run(key,JSON.stringify(model));
      if (scope.target_model!==key || force) {
        this.db.prepare('UPDATE scopes SET target_model=?,epoch=epoch+1 WHERE id=?').run(key,scopeId);
        this.db.prepare("UPDATE jobs SET state='skipped',request_json=NULL,error_code=NULL WHERE scope_id=? AND state IN ('pending','running')")
          .run(scopeId);
      }
      const assets=this.db.prepare("SELECT * FROM assets WHERE scope_id=? AND state='eligible' AND input_key IS NOT NULL").all(scopeId);
      for (const asset of assets) this.queueInside(asset);
      return this.coverage(scopeId);
    });
  }
  activate(scopeId,key) {
    return this.transaction(()=>{
      const scope=this.scope(scopeId); const count=this.coverage(scopeId);
      if (scope.target_model!==key || count.indexed!==count.total) throw new Failure('INDEX_INCOMPLETE',409);
      this.db.prepare('UPDATE scopes SET active_model=? WHERE id=?').run(key,scopeId);
      return this.coverage(scopeId);
    });
  }
  prune(scopeId) {
    return this.transaction(()=>{
      const scope=this.scope(scopeId,false);
      this.db.prepare('DELETE FROM embeddings WHERE scope_id=? AND model_key NOT IN (?,?)')
        .run(scopeId,scope.active_model,scope.target_model);
      this.db.prepare('UPDATE jobs SET request_json=NULL WHERE scope_id=? AND model_key NOT IN (?,?)')
        .run(scopeId,scope.active_model,scope.target_model);
      return {pruned:true};
    });
  }
}
