import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

export class Failure extends Error {
  constructor(code, status = 422, retryable = false) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH = /^[0-9a-f]{64}$/;
export const MAX_IMAGE = 20 * 1024 * 1024;
export const MAX_JSON = 16 * 1024;
const ajv = new Ajv2020({strict: true, allErrors: false});
const validators = Object.fromEntries(['image-request', 'text-request', 'image-result', 'text-result']
  .map(name => [name, ajv.compile(JSON.parse(readFileSync(
    new URL(`../../contracts/ml/v1/schemas/${name}.schema.json`, import.meta.url), 'utf8')))]));

export function validate(name, value) {
  if (!validators[name](value)) throw new Failure('INVALID_REQUEST');
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}
export function modelKey(model) {
  validate('text-request', {schema_version: '1', task: 'text_embedding',
    request_id: randomUUID(), scope_id: randomUUID(), model, text: 'validation'});
  return digest(model);
}
export function unit(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(
    value => typeof value !== 'number' || !Number.isFinite(value))) throw new Failure('INVALID_VECTOR', 502);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) throw new Failure('INVALID_VECTOR', 502);
  return vector;
}
export function matchResult(request, result) {
  validate(request.task === 'image_embedding' ? 'image-result' : 'text-result', result);
  unit(result.embedding, request.model.dimensions);
  if (result.request_id !== request.request_id || modelKey(result.model) !== modelKey(request.model)
      || (request.task === 'image_embedding'
        ? digest(result.subject) !== digest(request.subject) || result.image_sha256 !== request.image.sha256
        : result.scope_id !== request.scope_id)) throw new Failure('PROTOCOL_MISMATCH', 502);
  return result.embedding;
}
export function integer(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Failure('INVALID_REQUEST');
  return value;
}
export function identifier(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Failure('INVALID_REQUEST');
  return value;
}
export function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !(key in value))) throw new Failure('INVALID_REQUEST');
  return value;
}
