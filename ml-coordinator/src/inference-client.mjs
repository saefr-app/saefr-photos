import {randomUUID} from 'node:crypto';
import {Failure, matchResult, modelKey, validate} from './protocol.mjs';

export class InferenceClient {
  constructor(routes, {timeout = 30000, fetcher = fetch} = {}) {
    this.routes = new Map(); this.timeout = timeout; this.fetcher = fetcher;
    for (const entry of routes) {
      const url = new URL(entry.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || url.search || url.hash || url.pathname !== '/' || !/^[A-Za-z0-9_-]{32,256}$/.test(entry.token))
        throw new Failure('INVALID_CONFIGURATION', 503);
      const key = modelKey(entry.model);
      if (this.routes.has(key)) throw new Failure('INVALID_CONFIGURATION', 503);
      this.routes.set(key, {...entry, url: url.origin});
    }
  }
  model(key) {
    const route = this.routes.get(key);
    if (!route) throw new Failure('MODEL_MISMATCH', 409);
    return route.model;
  }
  async predict(request, content = null) {
    validate(content ? 'image-request' : 'text-request', request);
    const route = this.routes.get(modelKey(request.model));
    if (!route) throw new Failure('MODEL_MISMATCH', 409);
    let body, headers = {Authorization: `Bearer ${route.token}`};
    if (content) {
      body = new FormData();
      body.append('metadata', JSON.stringify(request));
      body.append('image', new Blob([content], {type: request.image.media_type}), 'image');
    } else { body = JSON.stringify(request); headers['Content-Type'] = 'application/json'; }
    try {
      const response = await this.fetcher(`${route.url}/v1/embeddings/${content ? 'image' : 'text'}`,
        {method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeout), redirect: 'error'});
      let size = 0; const chunks = [];
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > 256 * 1024) throw new Failure('PROTOCOL_MISMATCH', 502);
        chunks.push(Buffer.from(chunk));
      }
      if (!response.ok) {
        const transient = [429, 500, 502, 503, 504].includes(response.status);
        throw new Failure(transient ? 'INFERENCE_UNAVAILABLE' : 'INFERENCE_REJECTED', 502, transient);
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Failure('PROTOCOL_MISMATCH', 502); }
      try { return matchResult(request, result); }
      catch { throw new Failure('PROTOCOL_MISMATCH', 502); }
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure('INFERENCE_UNAVAILABLE', 502, true);
    }
  }
  async searchVector(scopeId, model, text) {
    const request = {schema_version:'1', task:'text_embedding', request_id:randomUUID(), scope_id:scopeId, model, text};
    if (typeof text !== 'string' || !text.trim()) throw new Failure('INVALID_REQUEST');
    return this.predict(request);
  }
}
