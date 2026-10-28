import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { PasswordService } from '../auth/password.service.js';
import { inspectAuthSchema } from '../database/migrations/auth-schema.js';
import { AUTHENTICATION_MIGRATION } from '../database/migrations/migration-provider.js';
import { getMigrationStatus } from '../database/migrations/migration-runner.js';
import type { Database } from '../database/database.types.js';
import { canonicalUsername } from './username.js';
import { UsersRepository, type UserRecord } from './users.repository.js';

export class OperatorAccountError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function exactUserId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new OperatorAccountError('A canonical user UUID is required.');
  return value;
}

export function boundedPruneLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1000
  )
    throw new OperatorAccountError('Session prune limit must be 1–1000.');
  return value;
}

/** Standalone operator operations; not imported by the HTTP application. */
export class OperatorAccountsService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly passwords = new PasswordService(),
  ) {}

  async requireManagedAuthSchema(): Promise<void> {
    const status = await getMigrationStatus(this.db);
    if (
      !status.migrations.some(
        (migration) =>
          migration.name === AUTHENTICATION_MIGRATION && migration.applied,
      )
    )
      throw new OperatorAccountError(
        'The approved authentication migration is not applied.',
      );
  }

  async bootstrapFirstAdmin(
    usernameInput: unknown,
    password: unknown,
  ): Promise<UserRecord> {
    const username = canonicalUsername(usernameInput);
    await this.requireManagedAuthSchema();
    const passwordHash = await this.passwords.hash(password);
    return this.db.transaction().execute(async (transaction) => {
      // The global first-user invariant must hold across separate processes.
      await sql`select pg_advisory_xact_lock(708202610210003::bigint)`.execute(
        transaction,
      );
      await inspectAuthSchema<Database>(transaction);
      const users = new UsersRepository(transaction);
      if (await users.hasAnyUser())
        throw new OperatorAccountError(
          'First administrator already initialized.',
        );
      return users.insertBootstrapAdmin(username, passwordHash);
    });
  }

  async createOrdinaryUser(
    usernameInput: unknown,
    password: unknown,
  ): Promise<UserRecord> {
    const username = canonicalUsername(usernameInput);
    await this.requireManagedAuthSchema();
    const passwordHash = await this.passwords.hash(password);
    // Internal foundation only; a later admin controller must authorize use.
    return new UsersRepository(this.db).insertOrdinaryUser(
      username,
      passwordHash,
    );
  }

  async recoverPassword(
    userIdInput: unknown,
    replacement: unknown,
  ): Promise<{ userId: string; revokedSessions: number }> {
    const userId = exactUserId(userIdInput);
    await this.requireManagedAuthSchema();
    const passwordHash = await this.passwords.hash(replacement);
    return this.db.transaction().execute(async (transaction) => {
      await inspectAuthSchema<Database>(transaction);
      const users = new UsersRepository(transaction);
      if (!(await users.findByIdForUpdate(userId)))
        throw new OperatorAccountError('Target account was not found.');
      await users.replacePassword(userId, passwordHash);
      const revokedSessions = await users.revokeSessions(userId);
      return { userId, revokedSessions };
    });
  }

  async pruneExpiredSessions(limitInput: unknown): Promise<number> {
    const limit = boundedPruneLimit(limitInput);
    await this.requireManagedAuthSchema();
    return new UsersRepository(this.db).pruneExpiredSessions(limit);
  }
}
