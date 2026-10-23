import {
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

import { AuthSessionService } from './auth-session.service.js';
import { exactOrigin, RequestAuthenticator } from './request-auth.js';
import { safeErrorCode } from '../errors/safe-error-code.js';

function assetNamespace(path: string): boolean {
  return path === '/api/v1/assets' || path.startsWith('/api/v1/assets/');
}

export function isAssetRequest(request: FastifyRequest): boolean {
  // The matched router pattern is authoritative for actual handlers. Also
  // protect unmatched namespace requests before parsing. decodeURI preserves
  // encoded separators, as find-my-way does when matching static segments.
  if (assetNamespace(request.routeOptions?.url ?? '')) return true;
  // find-my-way also accepts HTTP absolute-form targets. Remove only the
  // authority, without URL normalization (which would change dot segments).
  const path = (request.raw.url ?? '')
    .replace(/^https?:\/\/[^/?#]+/i, '')
    .split(/[?#]/, 1)[0];
  try {
    return assetNamespace(decodeURI(path));
  } catch {
    // Malformed URLs normally take the adapter's pre-hook framework error path.
    return assetNamespace(path);
  }
}

/** Authenticate and enforce unsafe-method CSRF before any content parser. */
export function registerAssetAccess(app: NestFastifyApplication): void {
  const authenticator = app.get(RequestAuthenticator);
  const config = app.get(ConfigService);
  const logger = new Logger('AssetAccess');
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      if (!isAssetRequest(request)) return;
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      try {
        const actor = await authenticator.resolve(request);
        if (!actor) throw new UnauthorizedException('Unauthorized');
        if (actor.passwordChangeRequired)
          throw new ForbiddenException('Forbidden');
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          exactOrigin(request, config);
          if (
            !AuthSessionService.validCsrf(
              actor,
              request.headers['x-csrf-token'],
            )
          )
            throw new ForbiddenException('Forbidden');
        }
      } catch (error) {
        const status =
          error instanceof UnauthorizedException
            ? 401
            : error instanceof ForbiddenException
              ? 403
              : 503;
        if (status === 503)
          logger.error(`Authentication lookup failed; ${safeErrorCode(error)}`);
        const label =
          status === 401
            ? 'Unauthorized'
            : status === 403
              ? 'Forbidden'
              : 'Service Unavailable';
        reply
          .type('application/json')
          .code(status)
          .send({
            statusCode: status,
            message: status === 503 ? 'Database unavailable' : label,
            error: label,
          });
      }
    });
}
