import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import type { AuthenticatedActor } from '../auth/auth-session.service.js';
import { PasswordService } from '../auth/password.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { Database } from '../database/database.types.js';
import { canonicalUsername } from './username.js';
import { UsersRepository, type UserRecord } from './users.repository.js';

export class AdminAccountError extends Error {
  constructor(readonly reason: 'invalid' | 'not_found' | 'cannot_disable') {
    super(reason);
  }
}

export function publicUser(user: UserRecord) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    passwordChangeRequired: user.password_change_required,
    createdAt: user.created_at.toISOString(),
    updatedAt: user.updated_at.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
  ) {}

  private async reauthenticate(
    transaction: Transaction<Database>,
    actor: AuthenticatedActor,
    currentPassword: string,
  ): Promise<void> {
    const user = await transaction
      .selectFrom('app_user')
      .select([
        'id',
        'role',
        'status',
        'password_change_required',
        'password_hash',
      ])
      .where('id', '=', actor.userId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !user ||
      user.role !== 'admin' ||
      user.status !== 'active' ||
      user.password_change_required ||
      !(await this.passwords.verify(currentPassword, user.password_hash))
    )
      throw new AdminAccountError('invalid');
  }

  async create(
    actor: AuthenticatedActor,
    usernameInput: string,
    initialPassword: string,
    currentPassword: string,
  ) {
    const username = canonicalUsername(usernameInput);
    const passwordHash = await this.passwords.hash(initialPassword);
    const created = await this.database.db
      .transaction()
      .execute(async (transaction) => {
        await this.reauthenticate(transaction, actor, currentPassword);
        return new UsersRepository(transaction).insertOrdinaryUser(
          username,
          passwordHash,
        );
      });
    return publicUser(created);
  }

  async list(limit: number, offset: number) {
    const rows = await this.database.db
      .selectFrom('app_user')
      .select([
        'id',
        'username',
        'role',
        'status',
        'password_change_required',
        'created_at',
        'updated_at',
      ])
      .orderBy('username', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .offset(offset)
      .execute();
    return { items: rows.map(publicUser), limit, offset };
  }

  async disable(
    actor: AuthenticatedActor,
    targetId: string,
    currentPassword: string,
  ): Promise<void> {
    await this.database.db.transaction().execute(async (transaction) => {
      // All administrator disable operations acquire this transaction lock
      // before account rows, so two administrators cannot disable each other.
      await sql`select pg_advisory_xact_lock(708202610210004::bigint)`.execute(
        transaction,
      );
      await this.reauthenticate(transaction, actor, currentPassword);
      if (targetId === actor.userId)
        throw new AdminAccountError('cannot_disable');
      const target = await transaction
        .selectFrom('app_user')
        .select(['id', 'role', 'status'])
        .where('id', '=', targetId)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw new AdminAccountError('not_found');
      if (target.role === 'admin' && target.status === 'active') {
        const active = await transaction
          .selectFrom('app_user')
          .select(sql<number>`count(*)::integer`.as('count'))
          .where('role', '=', 'admin')
          .where('status', '=', 'active')
          .executeTakeFirstOrThrow();
        if (active.count <= 1) throw new AdminAccountError('cannot_disable');
      }
      await transaction
        .updateTable('app_user')
        .set({
          status: 'disabled',
          updated_at: sql<Date>`greatest(updated_at + interval '1 microsecond', clock_timestamp())`,
        })
        .where('id', '=', target.id)
        .execute();
      await transaction
        .deleteFrom('auth_session')
        .where('user_id', '=', target.id)
        .execute();
    });
  }
}
