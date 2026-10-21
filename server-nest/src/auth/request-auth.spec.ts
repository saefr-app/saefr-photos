import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
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
