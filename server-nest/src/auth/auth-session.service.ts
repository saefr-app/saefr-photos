import { Injectable } from '@nestjs/common';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { getMigrationStatus } from '../database/migrations/migration-runner.js';
import {
  ASSET_LIFECYCLE_MIGRATION,
  INITIAL_ASSET_MIGRATION,
  AUTHENTICATION_MIGRATION,
  ASSET_OWNERSHIP_MIGRATION,
} from '../database/migrations/migration-provider.js';
import { PasswordService } from './password.service.js';

export interface AuthenticatedActor {
  userId: string;
  username: string;
  role: 'admin' | 'user';
  sessionId: string;
  expiresAt: Date;
  passwordChangeRequired: boolean;
  csrfToken: Buffer;
}

export class AuthenticationFailure extends Error {
  constructor(readonly reason: 'invalid' | 'session_limit' | 'not_found') {
    super(reason);
  }
}

function tokenHash(token: Buffer): Buffer {
  return createHash('sha256').update(token).digest();
}

function decodeToken(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const token = Buffer.from(value, 'base64url');
  return token.length === 32 && token.toString('base64url') === value
    ? token
    : null;
}

@Injectable()
export class AuthSessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
  ) {}

  async assertReady(): Promise<void> {
    const status = await getMigrationStatus(this.database.db);
    // M12B has no binding-aware storage provider. Refuse HTTP startup on any
    // M12 schema, even if a singleton was populated synthetically.
    if (
      status.migrations.some(
        (version) =>
          version.name === ASSET_LIFECYCLE_MIGRATION && version.applied,
      )
    )
      throw new Error('Application schema is not ready');
    if (
      ![
        INITIAL_ASSET_MIGRATION,
        AUTHENTICATION_MIGRATION,
        ASSET_OWNERSHIP_MIGRATION,
      ].every((name) =>
        status.migrations.some(
          (version) => version.name === name && version.applied,
        ),
      )
    )
      throw new Error('Application schema is not ready');
  }

  async login(
    username: string,
    password: string,
  ): Promise<{
    actor: AuthenticatedActor;
    credential: string;
  }> {
    const existing = await this.database.db
      .selectFrom('app_user')
      .select([
        'id',
        'password_hash',
        sql<string>`extract(epoch from updated_at)::text`.as('revision'),
      ])
      .where('username', '=', username)
      .executeTakeFirst();
    const verified = await this.passwords.verifyOrDummy(
      password,
      existing?.password_hash,
    );
    if (!existing || !verified) throw new AuthenticationFailure('invalid');

    return this.database.db.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom('app_user')
        .selectAll()
        .select(
          sql<string>`extract(epoch from updated_at)::text`.as('revision'),
        )
        .where('id', '=', existing.id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !user ||
        user.status !== 'active' ||
        user.password_hash !== existing.password_hash ||
        user.revision !== existing.revision
      )
        throw new AuthenticationFailure('invalid');
      const live = await transaction
        .selectFrom('auth_session')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('user_id', '=', user.id)
        .where('expires_at', '>', sql<Date>`current_timestamp`)
        .executeTakeFirstOrThrow();
      if (live.count >= 10) throw new AuthenticationFailure('session_limit');
      const credential = randomBytes(32);
      const csrfToken = randomBytes(32);
      const createdAt = new Date();
      const expiresAt = new Date(
        createdAt.getTime() +
          (user.password_change_required ? 15 * 60_000 : 7 * 86_400_000),
      );
      const sessionId = randomUUID();
      await transaction
        .insertInto('auth_session')
        .values({
          id: sessionId,
          user_id: user.id,
          token_hash: tokenHash(credential),
          csrf_token: csrfToken,
          created_at: createdAt,
          expires_at: expiresAt,
        })
        .execute();
      return {
        credential: credential.toString('base64url'),
        actor: {
          userId: user.id,
          username: user.username,
          role: user.role,
          sessionId,
          expiresAt,
          passwordChangeRequired: user.password_change_required,
          csrfToken,
        },
      };
    });
  }

  async resolve(credential: string): Promise<AuthenticatedActor | null> {
    const token = decodeToken(credential);
    if (!token) return null;
    const row = await this.database.db
      .selectFrom('auth_session as session')
      .innerJoin('app_user as user', 'user.id', 'session.user_id')
      .select([
        'user.id as userId',
        'user.username',
        'user.role',
        'user.status',
        'user.password_change_required as passwordChangeRequired',
        'session.id as sessionId',
        'session.expires_at as expiresAt',
        'session.csrf_token as csrfToken',
      ])
      .where('session.token_hash', '=', tokenHash(token))
      .where('session.expires_at', '>', sql<Date>`current_timestamp`)
      .executeTakeFirst();
    if (!row || row.status !== 'active') return null;
    return {
      userId: row.userId,
      username: row.username,
      role: row.role,
      sessionId: row.sessionId,
      expiresAt: row.expiresAt,
      passwordChangeRequired: row.passwordChangeRequired,
      csrfToken: row.csrfToken,
    };
  }

  static validCsrf(actor: AuthenticatedActor, candidate: unknown): boolean {
    if (typeof candidate !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(candidate))
      return false;
    const value = Buffer.from(candidate, 'base64url');
    return value.length === 32 && timingSafeEqual(actor.csrfToken, value);
  }

  async listSessions(actor: AuthenticatedActor) {
    const rows = await this.database.db
      .selectFrom('auth_session')
      .select(['id', 'created_at', 'expires_at'])
      .where('user_id', '=', actor.userId)
      .where('expires_at', '>', sql<Date>`current_timestamp`)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      current: row.id === actor.sessionId,
    }));
  }

  async logout(actor: AuthenticatedActor): Promise<void> {
    await this.database.db
      .deleteFrom('auth_session')
      .where('id', '=', actor.sessionId)
      .where('user_id', '=', actor.userId)
      .execute();
  }

  async logoutAll(actor: AuthenticatedActor): Promise<void> {
    await this.database.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('app_user')
        // This existing timestamp is also the login revision. Advance it
        // strictly, including when logout-all happens within one millisecond.
        .set({
          updated_at: sql<Date>`greatest(updated_at + interval '1 microsecond', clock_timestamp())`,
        })
        .where('id', '=', actor.userId)
        .returning('id')
        .executeTakeFirstOrThrow();
      await transaction
        .deleteFrom('auth_session')
        .where('user_id', '=', actor.userId)
        .execute();
    });
  }

  async revoke(actor: AuthenticatedActor, id: string): Promise<boolean> {
    return this.database.db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', actor.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const deleted = await transaction
        .deleteFrom('auth_session')
        .where('id', '=', id)
        .where('user_id', '=', actor.userId)
        .executeTakeFirst();
      return Number(deleted.numDeletedRows) === 1;
    });
  }

  async changePassword(
    actor: AuthenticatedActor,
    current: string,
    replacement: string,
  ): Promise<void> {
    const replacementHash = await this.passwords.hash(replacement);
    await this.database.db.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom('app_user')
        .selectAll()
        .where('id', '=', actor.userId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !user ||
        user.status !== 'active' ||
        !(await this.passwords.verify(current, user.password_hash))
      )
        throw new AuthenticationFailure('invalid');
      await transaction
        .updateTable('app_user')
        .set({
          password_hash: replacementHash,
          password_change_required: false,
          updated_at: new Date(),
        })
        .where('id', '=', actor.userId)
        .execute();
      await transaction
        .deleteFrom('auth_session')
        .where('user_id', '=', actor.userId)
        .execute();
    });
  }
}
