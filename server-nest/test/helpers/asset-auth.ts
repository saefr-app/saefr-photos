import type { FastifyRequest } from 'fastify';

import type { AuthenticatedActor } from '../../src/auth/auth-session.service.js';

export const assetActor: AuthenticatedActor = {
  userId: '00000000-0000-4000-8000-000000000100',
  username: 'assetfixture',
  role: 'user',
  sessionId: '00000000-0000-4000-8000-000000000200',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  passwordChangeRequired: false,
  csrfToken: Buffer.alloc(32, 1),
};

const testCookie = 'saefr_session_dev=isolated-asset-session';

// The real default-deny guard still runs. This isolated test double supplies
// an actor only for the explicit synthetic session credential.
export const assetAuthenticator = {
  resolve: async (
    request: FastifyRequest,
  ): Promise<AuthenticatedActor | null> =>
    request.headers.cookie === testCookie ? assetActor : null,
};

export function assetHeaders(unsafe = false): Record<string, string> {
  return {
    Cookie: testCookie,
    ...(unsafe
      ? {
          Origin: 'http://127.0.0.1:3000',
          'X-CSRF-Token': assetActor.csrfToken.toString('base64url'),
        }
      : {}),
  };
}
