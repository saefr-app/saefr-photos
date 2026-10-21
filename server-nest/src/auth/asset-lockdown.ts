import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedException } from '@nestjs/common';

export type AssetActor = { userId: string };
export type AssetActorResolver = (
  request: FastifyRequest,
) => Promise<AssetActor | null>;

function isAssetPath(rawUrl: string): boolean {
  try {
    const path = decodeURIComponent(rawUrl.split('?', 1)[0]);
    return path === '/api/v1/assets' || path.startsWith('/api/v1/assets/');
  } catch {
    return rawUrl.startsWith('/api/v1/assets');
  }
}

/** The production composition never mounts AssetsModule. This pre-parser hook
 * gives every asset namespace alias a fixed response before multipart work. */
export function registerAssetLockdown(
  app: NestFastifyApplication,
  resolveActor: AssetActorResolver = async () => null,
): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      if (!isAssetPath(request.raw.url ?? '')) return;

      let status = 401;
      try {
        status = (await resolveActor(request)) ? 503 : 401;
      } catch (error) {
        status = error instanceof UnauthorizedException ? 401 : 503;
      }
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.type('application/json');
      const error = status === 401 ? 'Unauthorized' : 'Service Unavailable';
      const message =
        status === 401 ? 'Unauthorized' : 'Asset access is unavailable';
      reply
        .code(status)
        .send(
          request.method === 'HEAD'
            ? undefined
            : { statusCode: status, message, error },
        );
    });
}
