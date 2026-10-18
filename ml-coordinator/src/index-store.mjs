import {DatabaseSync} from 'node:sqlite';
import {Failure, identifier, integer, modelKey, unit} from './protocol.mjs';

const APPLICATION_ID = 0x534d4c31;
export class IndexStore {
  constructor(filename, {maxAssets = 10000, maxBytes = 1024 ** 3} = {}) {
    this.maxAssets = integer(maxAssets);
    this.maxBytes = integer(maxBytes);
    this.db = new DatabaseSync(filename);
    const application = this.db.prepare('PRAGMA application_id').get().application_id;
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if ((application !== 0 && application !== APPLICATION_ID) || (application === 0 && tables.length)
        || (application === APPLICATION_ID && this.db.prepare('PRAGMA user_version').get().user_version !== 1)) {
      this.db.close();
      throw new Failure('UNRECOGNIZED_INDEX', 503);
    }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.db.exec(`BEGIN IMMEDIATE;
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
      CREATE TABLE IF NOT EXISTS models (key TEXT PRIMARY KEY, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_lease (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
        epoch INTEGER NOT NULL, active_model TEXT NOT NULL REFERENCES models(key),
        target_model TEXT NOT NULL REFERENCES models(key));
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
        generation INTEGER NOT NULL, state TEXT NOT NULL, checksum TEXT, byte_size INTEGER,
        media_type TEXT, input_key TEXT);
      CREATE INDEX IF NOT EXISTS assets_scope ON assets(scope_id,state);
      CREATE TABLE IF NOT EXISTS embeddings (asset_id TEXT NOT NULL REFERENCES assets(id),
        model_key TEXT NOT NULL REFERENCES models(key), scope_id TEXT NOT NULL, generation INTEGER NOT NULL,
        checksum TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(asset_id,model_key));
      CREATE INDEX IF NOT EXISTS embeddings_scope ON embeddings(scope_id,model_key);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id),
        scope_id TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, model_key TEXT NOT NULL,
        request_json TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,updated_at);
      COMMIT;`);
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    const fence=()=>{
      if(this.apiOwner) {
        const lease=this.db.prepare('SELECT owner,expires_at FROM api_lease WHERE id=1').get();
        if(!lease || lease.owner!==this.apiOwner || lease.expires_at<=Date.now())throw new Failure('API_LEASE_LOST',503);
      }
    };
    try { fence(); const result = operation(); fence(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  scope(scopeId, enabled = true) {
    identifier(scopeId);
    const scope = this.db.prepare('SELECT * FROM scopes WHERE id=?').get(scopeId);
    if (!scope || (enabled && !scope.enabled)) throw new Failure('NOT_FOUND', 404);
    return scope;
  }
  model(key) {
    const row = this.db.prepare('SELECT identity FROM models WHERE key=?').get(key);
    if (!row) throw new Failure('MODEL_MISMATCH', 409);
    return JSON.parse(row.identity);
  }
  createScope(scopeId, model) {
    identifier(scopeId);
    const key = modelKey(model);
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO models(key,identity) VALUES (?,?)').run(key, JSON.stringify(model));
      const existing = this.db.prepare('SELECT * FROM scopes WHERE id=?').get(scopeId);
      if (existing && existing.target_model !== key) throw new Failure('USE_REINDEX', 409);
      this.db.prepare('INSERT OR IGNORE INTO scopes VALUES (?,1,1,?,?)').run(scopeId, key, key);
      return this.scope(scopeId, false);
    });
  }
  asset(scopeId, assetId, eligible = true) {
    this.scope(scopeId, eligible);
    identifier(assetId);
    const asset = this.db.prepare('SELECT * FROM assets WHERE id=? AND scope_id=?').get(assetId, scopeId);
    if (!asset || (eligible && asset.state !== 'eligible')) throw new Failure('NOT_FOUND', 404);
    return asset;
  }
  registerInside(scopeId, assetId, generation, image, inputKey) {
    identifier(assetId); integer(generation);
    this.scope(scopeId);
    const existing = this.db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
    if (existing && (existing.scope_id !== scopeId || existing.state === 'deleted'
        || generation < existing.generation)) throw new Failure('STALE_ASSET', 409);
    if (existing && generation === existing.generation && (existing.state !== 'eligible'
        || (existing.checksum && (existing.checksum !== image.sha256
          || existing.byte_size !== image.byte_size || existing.media_type !== image.media_type)))) {
      throw new Failure('GENERATION_CONFLICT', 409);
    }
    if (!existing && this.db.prepare('SELECT count(*) AS n FROM assets WHERE scope_id=?')
      .get(scopeId).n >= this.maxAssets) throw new Failure('SCOPE_LIMIT', 413);
    const used = this.db.prepare('SELECT coalesce(sum(byte_size),0) AS n FROM assets WHERE input_key IS NOT NULL')
      .get().n - (existing?.input_key ? existing.byte_size : 0);
    if (used + image.byte_size > this.maxBytes) throw new Failure('CACHE_LIMIT', 413);
    if (existing && generation > existing.generation) {
      this.db.prepare('DELETE FROM embeddings WHERE asset_id=?').run(assetId);
      this.db.prepare("UPDATE jobs SET state='skipped',request_json=NULL,error_code=NULL WHERE asset_id=? AND state!='done'")
        .run(assetId);
    }
    this.db.prepare(`INSERT INTO assets VALUES (?,?,?,'eligible',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,state='eligible',
      checksum=excluded.checksum,byte_size=excluded.byte_size,media_type=excluded.media_type,input_key=excluded.input_key`)
      .run(assetId, scopeId, generation, image.sha256, image.byte_size, image.media_type, inputKey);
    return {asset: this.asset(scopeId, assetId), obsoleteInputs: existing?.input_key && existing.input_key !== inputKey
      ? [existing.input_key] : []};
  }
  register(scopeId, assetId, generation, image, inputKey) {
    return this.transaction(() => this.registerInside(scopeId, assetId, generation, image, inputKey));
  }
  publishInside(request, vector, expectedEpoch) {
    const key = modelKey(request.model);
    unit(vector, request.model.dimensions);
    const scope = this.db.prepare('SELECT * FROM scopes WHERE id=?').get(request.subject.scope_id);
    const asset = this.db.prepare('SELECT * FROM assets WHERE id=?').get(request.subject.asset_id);
    if (!scope?.enabled || scope.epoch !== expectedEpoch || scope.target_model !== key
        || !asset || asset.state !== 'eligible' || asset.scope_id !== scope.id
        || asset.generation !== request.subject.generation || asset.checksum !== request.image.sha256) return false;
    this.db.prepare(`INSERT INTO embeddings VALUES (?,?,?,?,?,?) ON CONFLICT(asset_id,model_key)
      DO UPDATE SET scope_id=excluded.scope_id,generation=excluded.generation,
      checksum=excluded.checksum,vector=excluded.vector`)
      .run(asset.id, key, scope.id, asset.generation, asset.checksum, JSON.stringify(vector));
    return true;
  }
  publish(request, vector, epoch) {
    return this.transaction(() => this.publishInside(request, vector, epoch));
  }
  rows(scopeId, key) {
    return this.db.prepare(`SELECT e.asset_id,e.vector,e.checksum FROM embeddings e JOIN assets a ON a.id=e.asset_id
      WHERE e.scope_id=? AND a.scope_id=? AND e.model_key=? AND a.state='eligible'
        AND a.generation=e.generation AND a.checksum=e.checksum ORDER BY e.asset_id`).all(scopeId, scopeId, key);
  }
  search(scopeId, expectedModel, vector, {limit = 20, minScore = -1, exclude = null} = {}) {
    integer(limit, 1, 100);
    if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < -1 || minScore > 1)
      throw new Failure('INVALID_REQUEST');
    unit(vector, this.model(expectedModel).dimensions);
    // A single read transaction supplies one consistent scope/model/asset snapshot.
    this.db.exec('BEGIN');
    try {
      const scope = this.scope(scopeId);
      if (scope.active_model !== expectedModel) throw new Failure('MODEL_CHANGED', 409);
      const best = [];
      for (const row of this.rows(scopeId, expectedModel)) {
        if (row.asset_id === exclude) continue;
        const values = JSON.parse(row.vector);
        const score = Math.max(-1, Math.min(1, values.reduce((sum, value, i) => sum + value * vector[i], 0)));
        if (score < minScore) continue;
        best.push({asset_id: row.asset_id, score});
        best.sort((a,b) => b.score - a.score || a.asset_id.localeCompare(b.asset_id));
        if (best.length > limit) best.pop();
      }
      this.db.exec('COMMIT');
      return {model_key: expectedModel, results: best};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  inputReferenced(key) {
    return Boolean(this.db.prepare('SELECT 1 FROM assets WHERE input_key=?').get(key));
  }
}
