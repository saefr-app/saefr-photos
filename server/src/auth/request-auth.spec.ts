import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import {
  AuthSessionService,
  type AuthenticatedActor,
} from './auth-session.service.js';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  DefaultDenyGuard,
  RequestAuthenticator,
  clearSessionCookie,
  cookieName,
  exactOrigin,
  sessionCookie,
  sessionCredential,
} from './request-auth.js';

function request(headers: Record<string, string>): FastifyRequest {
  return { headers } as FastifyRequest;
}

describe('browser credential policy', () => {
  const production = new ConfigService({
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://photos.example.test',
  });
  const development = new ConfigService({
    NODE_ENV: 'test',
    APP_ORIGIN: 'http://127.0.0.1:3000',
  });

  it('uses the host-only secure production cookie and separate loopback cookie', () => {
    const expires = new Date(Date.now() + 86_400_000);
    expect(cookieName(production)).toBe('__Host-saefr_session');
    expect(sessionCookie(production, 'synthetic', expires)).toContain(
      '; Path=/; HttpOnly; SameSite=Lax; Secure;',
    );
    expect(sessionCookie(production, 'synthetic', expires)).not.toContain(
      'Domain=',
    );
    expect(cookieName(development)).toBe('saefr_session_dev');
    expect(clearSessionCookie(production)).toContain('Max-Age=0');
  });

  it('rejects foreign or absent Origin and ambiguous credentials', () => {
    expect(() =>
      exactOrigin(request({ origin: 'http://127.0.0.1:3000' }), development),
    ).not.toThrow();
    expect(() =>
      exactOrigin(request({ origin: 'null' }), development),
    ).toThrow();
    expect(() => exactOrigin(request({}), development)).toThrow();
    expect(
      sessionCredential(
        request({ cookie: 'saefr_session_dev=token' }),
        development,
      ),
    ).toBe('token');
    expect(
      sessionCredential(
        request({ cookie: 'saefr_session_dev=a; saefr_session_dev=b' }),
        development,
      ),
    ).toBeNull();
    expect(() =>
      sessionCredential(
        request({ authorization: 'Bearer synthetic' }),
        development,
      ),
    ).toThrow();
  });
});

function fixture(method = 'GET') {
  const actor: AuthenticatedActor = {
    userId: '00000000-0000-4000-8000-000000000001',
    username: 'fixture',
    role: 'user',
    sessionId: '00000000-0000-4000-8000-000000000002',
    expiresAt: new Date(Date.now() + 60000),
    passwordChangeRequired: false,
    csrfToken: Buffer.alloc(32, 1),
  };
  const resolve = vi.fn().mockResolvedValue(actor);
  const sessions = { resolve } as unknown as AuthSessionService;
  const config = new ConfigService({
    NODE_ENV: 'test',
    APP_ORIGIN: 'http://127.0.0.1:3000',
  });
  const authenticator = new RequestAuthenticator(sessions, config);
  const request = {
    headers: { cookie: 'saefr_session_dev=synthetic-fixture' },
    method,
    url: '/api/v1/assets',
  } as FastifyRequest;
  return { actor, resolve, sessions, config, authenticator, request };
}

describe('request-local authentication snapshot', () => {
  it('reuses identity only within the same request; future requests resolve current session state', async () => {
    const f = fixture();
    expect(await f.authenticator.resolve(f.request)).toBe(f.actor);
    expect(await f.authenticator.resolve(f.request)).toBe(f.actor);
    expect(f.resolve).toHaveBeenCalledTimes(1);
    f.resolve.mockResolvedValueOnce(null);
    expect(await f.authenticator.resolve({ ...f.request })).toBeNull();
    expect(f.resolve).toHaveBeenCalledTimes(2);
  });

  it.each(['authorization', 'proxy-authorization'])(
    'rejects %s even after caching an actor',
    async (header) => {
      const f = fixture();
      await f.authenticator.resolve(f.request);
      f.request.headers[header] = 'synthetic unsupported credential';
      await expect(f.authenticator.resolve(f.request)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      delete f.request.headers[header];
      f.request.headers.cookie += '; saefr_session_dev=duplicate';
      expect(await f.authenticator.resolve(f.request)).toBeNull();
    },
  );

  it('does not skip guard Origin, CSRF or restricted-route checks after early resolution', async () => {
    const f = fixture('POST');
    await f.authenticator.resolve(f.request);
    const guard = new DefaultDenyGuard(
      new Reflector(),
      f.authenticator,
      f.sessions,
      f.config,
    );
    const context = {
      getHandler: () => () => {},
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => f.request,
        getResponse: () => ({}),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    f.request.headers.origin = 'http://127.0.0.1:3000';
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    f.request.headers['x-csrf-token'] = f.actor.csrfToken.toString('base64url');
    expect(await guard.canActivate(context)).toBe(true);
    f.actor.passwordChangeRequired = true;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
});
