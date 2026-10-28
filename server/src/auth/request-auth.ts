import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  AuthSessionService,
  type AuthenticatedActor,
} from './auth-session.service.js';
import { safeErrorCode } from '../errors/safe-error-code.js';

const PUBLIC_ROUTE = 'saefr:public';
export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true);

export type ActorRequest = FastifyRequest & { authActor?: AuthenticatedActor };

export function cookieName(config: ConfigService): string {
  return config.getOrThrow<string>('NODE_ENV') === 'production'
    ? '__Host-saefr_session'
    : 'saefr_session_dev';
}

export function sessionCookie(
  config: ConfigService,
  credential: string,
  expiresAt: Date,
): string {
  const secure =
    config.getOrThrow<string>('NODE_ENV') === 'production' ? '; Secure' : '';
  const maxAge = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  return `${cookieName(config)}=${credential}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}`;
}

export function clearSessionCookie(config: ConfigService): string {
  const secure =
    config.getOrThrow<string>('NODE_ENV') === 'production' ? '; Secure' : '';
  return `${cookieName(config)}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function exactOrigin(
  request: FastifyRequest,
  config: ConfigService,
): void {
  if (request.headers.origin !== config.getOrThrow<string>('APP_ORIGIN'))
    throw new ForbiddenException('Forbidden');
}

export function sessionCredential(
  request: FastifyRequest,
  config: ConfigService,
): string | null {
  if (
    request.headers.authorization !== undefined ||
    request.headers['proxy-authorization'] !== undefined
  )
    throw new UnauthorizedException('Unauthorized');
  const name = cookieName(config);
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim());
  const found = values.filter((part) => part.startsWith(`${name}=`));
  if (found.length !== 1) return null;
  return found[0].slice(name.length + 1);
}

@Injectable()
export class RequestAuthenticator {
  // Request-local snapshot only. No client header/property can populate it.
  // The gate and guard still independently enforce their route/CSRF policies.
  private readonly actors = new WeakMap<
    FastifyRequest,
    { credential: string; actor: AuthenticatedActor }
  >();
  constructor(
    private readonly sessions: AuthSessionService,
    private readonly config: ConfigService,
  ) {}

  async resolve(request: FastifyRequest): Promise<AuthenticatedActor | null> {
    const credential = sessionCredential(request, this.config);
    if (!credential) return null;
    const cached = this.actors.get(request);
    if (cached?.credential === credential) return cached.actor;
    const actor = await this.sessions.resolve(credential);
    if (actor) this.actors.set(request, { credential, actor });
    return actor;
  }
}

@Injectable()
export class DefaultDenyGuard implements CanActivate {
  private readonly logger = new Logger(DefaultDenyGuard.name);
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: RequestAuthenticator,
    private readonly sessions: AuthSessionService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<ActorRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    let actor: AuthenticatedActor | null;
    try {
      actor = await this.authenticator.resolve(request);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.error(
        `Authentication lookup failed; ${safeErrorCode(error)}`,
      );
      throw new ServiceUnavailableException('Database unavailable');
    }
    if (!actor) {
      if (request.url.startsWith('/api/v1/auth/logout'))
        reply.header('Set-Cookie', clearSessionCookie(this.config));
      throw new UnauthorizedException('Unauthorized');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      exactOrigin(request, this.config);
      if (!AuthSessionService.validCsrf(actor, request.headers['x-csrf-token']))
        throw new ForbiddenException('Forbidden');
    }
    const path = request.url.split('?', 1)[0];
    if (
      actor.passwordChangeRequired &&
      path !== '/api/v1/me' &&
      path !== '/api/v1/auth/password' &&
      path !== '/api/v1/auth/logout' &&
      path !== '/api/v1/auth/logout-all' &&
      path !== '/api/v1/auth/sessions' &&
      !path.startsWith('/api/v1/auth/sessions/')
    )
      throw new ForbiddenException('Forbidden');
    request.authActor = actor;
    return true;
  }
}
