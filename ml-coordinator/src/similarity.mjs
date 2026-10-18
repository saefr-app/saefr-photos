import {Failure, identifier} from './protocol.mjs';

export function similar(store, scopeId, assetId, options = {}) {
  store.asset(scopeId, assetId);
  const key = store.scope(scopeId).active_model;
  const source = store.rows(scopeId, key).find(row => row.asset_id === assetId);
  if (!source) throw new Failure('INDEX_PENDING', 409);
  return {source_asset_id: assetId, ...store.search(scopeId, key, JSON.parse(source.vector),
    {...options, exclude: assetId})};
}

function score(a, b) {
  if (a.checksum === b.checksum) return 1;
  return Math.max(-1, Math.min(1, a.values.reduce((sum, v, i) => sum + v * b.values[i], 0)));
}

export function duplicateSuggestions(store, scopeId, assetIds, minScore = 0.995) {
  if (!Array.isArray(assetIds) || assetIds.length < 2 || assetIds.length > 256
      || new Set(assetIds).size !== assetIds.length || typeof minScore !== 'number'
      || !Number.isFinite(minScore) || minScore < 0.9 || minScore > 1) throw new Failure('INVALID_REQUEST');
  assetIds.forEach(identifier);
  const key = store.scope(scopeId).active_model;
  const indexed = new Map(store.rows(scopeId, key).map(row => [row.asset_id, row]));
  const groups = [];
  for (const id of [...assetIds].sort()) {
    store.asset(scopeId, id); // No indication that an asset in another scope exists.
    const row = indexed.get(id);
    if (!row) throw new Failure('INDEX_PENDING', 409);
    const candidate = {...row, values: JSON.parse(row.vector)};
    // Complete-link groups avoid chaining A~B and B~C into a misleading A~C group.
    const group = groups.find(items => items.every(item => score(item, candidate) >= minScore));
    if (group) group.push(candidate); else groups.push([candidate]);
  }
  return {model_key: key, suggestions_only: true, groups: groups.filter(group => group.length > 1).map(group => {
    let minimum = 1;
    for (let i=0;i<group.length;i++) for (let j=i+1;j<group.length;j++) minimum=Math.min(minimum,score(group[i],group[j]));
    return {kind: new Set(group.map(row=>row.checksum)).size === 1 ? 'exact' : 'near',
      asset_ids: group.map(row=>row.asset_id), min_similarity: minimum};
  })};
}
