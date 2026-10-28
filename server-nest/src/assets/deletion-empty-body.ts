import type { FastifyRequest } from 'fastify';

/** Reject framed bodies before parsing, including streaming multipart bodies. */
export function hasDeletionBody(request: FastifyRequest): boolean {
  return (
    request.body !== undefined ||
    request.headers['transfer-encoding'] !== undefined ||
    (request.headers['content-length'] !== undefined &&
      request.headers['content-length'] !== '0')
  );
}

export function isEmptyBodyMutation(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  return (
    (request.method === 'DELETE' && route === '/api/v1/assets/:assetId') ||
    (request.method === 'POST' &&
      (route === '/api/v1/assets/deletions/:assetId/retry' ||
        route === '/api/v1/assets/:assetId/trash' ||
        route === '/api/v1/assets/:assetId/restore'))
  );
}
