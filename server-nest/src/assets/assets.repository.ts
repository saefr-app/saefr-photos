import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { sql, type Insertable, type Selectable } from 'kysely';

import type { AuthenticatedActor } from '../auth/auth-session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { AssetTable } from '../database/database.types.js';
import { ASSET_LIFECYCLE_MIGRATION } from '../database/migrations/migration-provider.js';
import {
  nextVersion,
  parseIfMatch,
  type PageCursor,
} from './asset-lifecycle-contract.js';
import {
  assertAssetIdNotRetiredIfPresent,
  lockAssetId,
} from './asset-id-coordination.js';

export type AssetRecord = Pick<
  Selectable<AssetTable>,
  'id' | 'filename' | 'mime_type' | 'size' | 'created_at'
> & { lifecycle_version: string };

export type PageAssetRecord = AssetRecord & {
  cursor_timestamp: string;
  trashed_at?: Date | null;
  trashed_timestamp?: string | null;
};

export interface PendingDeletionRecord {
  asset_id: string;
  requested_timestamp: string;
  last_error_code: string | null;
}

export interface LifecycleResult {
  id: string;
  lifecycle_version: string;
  trashed_timestamp: string | null;
}

export type AssetFileRecord = Pick<
  Selectable<AssetTable>,
  'id' | 'mime_type' | 'storage_path'
>;

export type NewAsset = Omit<Insertable<AssetTable>, 'owner_id'>;

export type AssetPersistenceResult =
  | { status: 'committed'; asset: AssetRecord }
  | { status: 'not_started'; error: unknown }
  | { status: 'rolled_back'; error: unknown }
  | { status: 'uncertain'; error: unknown };

class CallbackAbort extends Error {
  constructor(readonly original: unknown) {
    super('Asset transaction callback aborted');
  }
}

@Injectable()
export class AssetsRepository {
  constructor(private readonly database: DatabaseService) {}

  async hasLifecycleSchema(): Promise<boolean> {
    const result = await sql<{ present: boolean }>`select exists (
      select 1 from public.kysely_migration where name = ${ASSET_LIFECYCLE_MIGRATION}
    ) as present`.execute(this.database.db);
    return result.rows[0]?.present === true;
  }

  async findPage(
    ownerId: string,
    collection: 'active' | 'trash',
    limit: number,
    cursor: PageCursor | null,
  ): Promise<PageAssetRecord[]> {
    const m12 = await this.hasLifecycleSchema();
    if (collection === 'trash' && !m12)
      throw new ServiceUnavailableException('Service unavailable');
    const afterActive = cursor
      ? sql`and (created_at, id) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`
      : sql``;
    const afterTrash = cursor
      ? sql`and (trashed_at, id) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`
      : sql``;
    const base = sql`id, filename, mime_type, size, created_at,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp`;
    if (!m12)
      return (
        await sql<PageAssetRecord>`select ${base}, '0'::text as lifecycle_version
        from public.asset where owner_id = ${ownerId}::uuid ${afterActive}
        order by created_at desc, id desc limit ${limit + 1}`.execute(
          this.database.db,
        )
      ).rows;
    if (collection === 'active')
      return (
        await sql<PageAssetRecord>`select ${base}, lifecycle_version::text as lifecycle_version
        from public.asset where owner_id = ${ownerId}::uuid and trashed_at is null ${afterActive}
        order by created_at desc, id desc limit ${limit + 1}`.execute(
          this.database.db,
        )
      ).rows;
    return (
      await sql<PageAssetRecord>`select ${base}, lifecycle_version::text as lifecycle_version,
      trashed_at, to_char(trashed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trashed_timestamp
      from public.asset where owner_id = ${ownerId}::uuid and trashed_at is not null ${afterTrash}
      order by trashed_at desc, id desc limit ${limit + 1}`.execute(
        this.database.db,
      )
    ).rows;
  }

  /** Bounded compatibility helper for isolated historical component tests. HTTP uses findPage. */
  async findAll(ownerId: string): Promise<AssetRecord[]> {
    return (await this.findPage(ownerId, 'active', 100, null)).slice(0, 100);
  }

  async findPendingDeletions(
    ownerId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<PendingDeletionRecord[]> {
    if (!(await this.hasLifecycleSchema()))
      throw new ServiceUnavailableException('Service unavailable');
    const after = cursor
      ? sql`and (requested_at, asset_id) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`
      : sql``;
    return (
      await sql<PendingDeletionRecord>`select asset_id, last_error_code,
      to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as requested_timestamp
      from public.asset_deletion where owner_id = ${ownerId}::uuid and completed_at is null ${after}
      order by requested_at desc, asset_id desc limit ${limit + 1}`.execute(
        this.database.db,
      )
    ).rows;
  }

  async findById(
    assetId: string,
    ownerId: string,
  ): Promise<AssetRecord | undefined> {
    const m12 = await this.hasLifecycleSchema();
    const version = m12 ? sql`lifecycle_version::text` : sql`'0'::text`;
    const active = m12 ? sql`and trashed_at is null` : sql``;
    const result =
      await sql<AssetRecord>`select id, filename, mime_type, size, created_at,
      ${version} as lifecycle_version from public.asset
      where id = ${assetId}::uuid and owner_id = ${ownerId}::uuid ${active}`.execute(
        this.database.db,
      );
    return result.rows[0];
  }

  async findFileById(
    assetId: string,
    ownerId: string,
  ): Promise<AssetFileRecord | undefined> {
    const active = (await this.hasLifecycleSchema())
      ? sql`and trashed_at is null`
      : sql``;
    const result = await sql<AssetFileRecord>`select id, mime_type, storage_path
      from public.asset where id = ${assetId}::uuid and owner_id = ${ownerId}::uuid ${active}`.execute(
      this.database.db,
    );
    return result.rows[0];
  }

  async findTrashFileById(
    assetId: string,
    ownerId: string,
  ): Promise<AssetFileRecord | undefined> {
    if (!(await this.hasLifecycleSchema()))
      throw new ServiceUnavailableException('Service unavailable');
    const result = await sql<AssetFileRecord>`select id, mime_type, storage_path
      from public.asset where id = ${assetId}::uuid and owner_id = ${ownerId}::uuid
        and trashed_at is not null`.execute(this.database.db);
    return result.rows[0];
  }

  async transition(
    actor: AuthenticatedActor,
    assetId: string,
    target: 'active' | 'trashed',
    ifMatch: string | string[] | undefined,
  ): Promise<LifecycleResult> {
    if (!(await this.hasLifecycleSchema()))
      throw new ServiceUnavailableException('Service unavailable');
    return this.database.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (transaction) => {
        const user = await transaction
          .selectFrom('app_user')
          .select(['status', 'password_change_required'])
          .where('id', '=', actor.userId)
          .forUpdate()
          .executeTakeFirst();
        if (!user || user.status !== 'active')
          throw new UnauthorizedException('Unauthorized');
        const session = await transaction
          .selectFrom('auth_session')
          .select('id')
          .where('id', '=', actor.sessionId)
          .where('user_id', '=', actor.userId)
          .forUpdate()
          .executeTakeFirst();
        if (!session) throw new UnauthorizedException('Unauthorized');
        await lockAssetId(transaction, assetId);
        const locked = await sql<
          LifecycleResult & { trashed_at: Date | null }
        >`select id,
        lifecycle_version::text as lifecycle_version, trashed_at,
        to_char(trashed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trashed_timestamp
        from public.asset where id = ${assetId}::uuid and owner_id = ${actor.userId}::uuid
        for update`.execute(transaction);
        const asset = locked.rows[0];
        if (!asset) throw new NotFoundException('Asset not found');
        const validity = await sql<{
          valid: boolean;
        }>`select s.expires_at > clock_timestamp() as valid
        from public.auth_session s where s.id = ${actor.sessionId}::uuid
          and s.user_id = ${actor.userId}::uuid`.execute(transaction);
        if (!validity.rows[0]?.valid)
          throw new UnauthorizedException('Unauthorized');
        if (user.password_change_required)
          throw new ForbiddenException('Forbidden');
        const expectedVersion = parseIfMatch(ifMatch, assetId);
        if (asset.lifecycle_version !== expectedVersion)
          throw new HttpException('Lifecycle version conflict', 412);
        if ((target === 'trashed') === (asset.trashed_at !== null))
          return {
            id: asset.id,
            lifecycle_version: asset.lifecycle_version,
            trashed_timestamp: asset.trashed_timestamp,
          };
        const version = nextVersion(asset.lifecycle_version);
        const timestamp =
          target === 'trashed' ? sql`clock_timestamp()` : sql`null`;
        const changed = await sql<LifecycleResult>`update public.asset
        set trashed_at = ${timestamp}, lifecycle_version = ${version}::bigint
        where id = ${assetId}::uuid and owner_id = ${actor.userId}::uuid
        returning id, lifecycle_version::text as lifecycle_version,
        to_char(trashed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trashed_timestamp`.execute(
          transaction,
        );
        return changed.rows[0];
      });
  }

  async createForActor(
    actor: AuthenticatedActor,
    asset: NewAsset,
  ): Promise<AssetPersistenceResult> {
    let callbackEntered = false;
    let callbackAbort: CallbackAbort | undefined;

    try {
      const created = await this.database.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (transaction) => {
          callbackEntered = true;
          try {
            const user = await transaction
              .selectFrom('app_user')
              .select(['status', 'password_change_required'])
              .where('id', '=', actor.userId)
              .forUpdate()
              .executeTakeFirst();
            if (!user || user.status !== 'active') {
              throw new UnauthorizedException('Unauthorized');
            }
            const session = await transaction
              .selectFrom('auth_session')
              .select('id')
              .where('id', '=', actor.sessionId)
              .where('user_id', '=', actor.userId)
              .forUpdate()
              .executeTakeFirst();
            if (!session) {
              throw new UnauthorizedException('Unauthorized');
            }

            // This separate statement uses database wall time after both
            // locks; current_timestamp would be fixed at transaction start.
            const expiry = await transaction
              .selectFrom('auth_session')
              .select(sql<boolean>`expires_at > clock_timestamp()`.as('valid'))
              .where('id', '=', actor.sessionId)
              .where('user_id', '=', actor.userId)
              .executeTakeFirst();
            if (!expiry?.valid) {
              throw new UnauthorizedException('Unauthorized');
            }
            if (user.password_change_required) {
              throw new ForbiddenException('Forbidden');
            }

            // The M12 upload/deletion boundary serializes UUID decisions.
            // Account and session locks must precede this advisory lock.
            await lockAssetId(transaction, asset.id);
            await assertAssetIdNotRetiredIfPresent(transaction, asset.id);

            // The advisory lock can wait past expiry. Row locks prevent
            // revocation races, but cannot stop database time from advancing.
            const afterCoordination = await transaction
              .selectFrom('auth_session')
              .select(sql<boolean>`expires_at > clock_timestamp()`.as('valid'))
              .where('id', '=', actor.sessionId)
              .where('user_id', '=', actor.userId)
              .executeTakeFirst();
            if (!afterCoordination?.valid) {
              throw new UnauthorizedException('Unauthorized');
            }

            return await transaction
              .insertInto('asset')
              .values({ ...asset, owner_id: actor.userId })
              .returning(['id', 'filename', 'mime_type', 'size', 'created_at'])
              .executeTakeFirstOrThrow();
          } catch (error: unknown) {
            callbackAbort = new CallbackAbort(error);
            throw callbackAbort;
          }
        });
      return {
        status: 'committed',
        asset: { ...created, lifecycle_version: '0' },
      };
    } catch (error: unknown) {
      // Connection acquisition and BEGIN precede the callback. Without
      // callback entry this attempt could not have inserted metadata.
      if (!callbackEntered) {
        return { status: 'not_started', error };
      }
      // Installed Kysely rethrows the callback error only after rollback
      // succeeds; rollback failure replaces it. A failed COMMIT also enters
      // rollback, so post-callback failure is always treated as uncertain.
      if (callbackAbort && error === callbackAbort) {
        return { status: 'rolled_back', error: callbackAbort.original };
      }
      return { status: 'uncertain', error };
    }
  }
}
