import { randomUUID } from 'node:crypto';

import { sql, type Kysely, type Selectable } from 'kysely';

import type { AppUserTable, Database } from '../database/database.types.js';

export type UserRecord = Pick<
  Selectable<AppUserTable>,
  | 'id'
  | 'username'
  | 'role'
  | 'status'
  | 'password_change_required'
  | 'created_at'
  | 'updated_at'
>;

export class UsernameConflictError extends Error {
  constructor() {
    super('Username already exists.');
  }
}

function usernameConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'app_user_username_key'
  );
}

/** Internal persistence only. Authorization belongs to the later HTTP layer. */
export class UsersRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async hasAnyUser(): Promise<boolean> {
    return Boolean(
      await this.db
        .selectFrom('app_user')
        .select('id')
        .limit(1)
        .executeTakeFirst(),
    );
  }

  async findCredentialsByUsername(username: string) {
    return this.db
      .selectFrom('app_user')
      .select([
        'id',
        'password_hash',
        'role',
        'status',
        'password_change_required',
      ])
      .where('username', '=', username)
      .executeTakeFirst();
  }

  async findByIdForUpdate(id: string) {
    return this.db
      .selectFrom('app_user')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  async insertBootstrapAdmin(username: string, passwordHash: string) {
    return this.insertUser(username, passwordHash, 'admin', false);
  }

  async insertOrdinaryUser(username: string, passwordHash: string) {
    return this.insertUser(username, passwordHash, 'user', true);
  }

  private async insertUser(
    username: string,
    passwordHash: string,
    role: 'admin' | 'user',
    passwordChangeRequired: boolean,
  ): Promise<UserRecord> {
    const now = new Date();
    try {
      return await this.db
        .insertInto('app_user')
        .values({
          id: randomUUID(),
          username,
          password_hash: passwordHash,
          role,
          status: 'active',
          password_change_required: passwordChangeRequired,
          created_at: now,
          updated_at: now,
        })
        .returning([
          'id',
          'username',
          'role',
          'status',
          'password_change_required',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (usernameConflict(error)) throw new UsernameConflictError();
      throw error;
    }
  }

  async replacePassword(id: string, passwordHash: string): Promise<void> {
    await this.db
      .updateTable('app_user')
      .set({
        password_hash: passwordHash,
        password_change_required: true,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  async revokeSessions(id: string): Promise<number> {
    const result = await this.db
      .deleteFrom('auth_session')
      .where('user_id', '=', id)
      .executeTakeFirstOrThrow();
    return Number(result.numDeletedRows);
  }

  async pruneExpiredSessions(limit: number): Promise<number> {
    const results = await this.db
      .deleteFrom('auth_session')
      .where('id', 'in', (expression) =>
        expression
          .selectFrom('auth_session')
          .select('id')
          .where('expires_at', '<=', sql<Date>`current_timestamp`)
          .orderBy('expires_at')
          .orderBy('id')
          .limit(limit),
      )
      .returning('id')
      .execute();
    return results.length;
  }
}
