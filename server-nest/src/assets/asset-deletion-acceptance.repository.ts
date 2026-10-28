import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { sql } from 'kysely';

import type { AuthenticatedActor } from '../auth/auth-session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { StorageBinding } from '../storage/storage-binding.service.js';
import { parseIfMatch } from './asset-lifecycle-contract.js';
import { lockAssetId } from './asset-id-coordination.js';

export interface PublicDeletionReceipt {
  asset_id: string;
  status: 'pending' | 'completed';
  requested_at: string;
  completed_at: string | null;
  last_error_code: string | null;
}

interface ReceiptRow extends PublicDeletionReceipt {
  owner_id: string;
  accepted_lifecycle_version: string;
  storage_id: string;
  originals_binding_id: string;
  thumbnails_binding_id: string;
  storage_layout_version: number;
  original_extension: string;
}

interface AssetCandidate {
  id: string;
  lifecycle_version: string;
  trashed_at: Date | null;
  mime_type: string;
}

const receiptColumns = sql`asset_id, owner_id,
  accepted_lifecycle_version::text as accepted_lifecycle_version,
  storage_id, originals_binding_id, thumbnails_binding_id,
  storage_layout_version, original_extension,
  to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as requested_at,
  to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as completed_at,
  last_error_code`;

function publicReceipt(row: ReceiptRow): PublicDeletionReceipt {
  return {
    asset_id: row.asset_id,
    status: row.completed_at === null ? 'pending' : 'completed',
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    last_error_code: row.last_error_code,
  };
}

export type AcceptanceResult =
  | { status: 'existing'; receipt: PublicDeletionReceipt }
  | { status: 'committed'; receipt: PublicDeletionReceipt }
  | { status: 'not_started' | 'rolled_back'; error: unknown }
  | { status: 'uncertain'; expected: AcceptedTarget };

export interface AcceptedTarget {
  assetId: string;
  ownerId: string;
  version: string;
  storage: StorageBinding;
  extension: string;
}

class CallbackAbort extends Error {
  constructor(readonly original: unknown) {
    super('Deletion acceptance callback aborted');
  }
}

@Injectable()
export class AssetDeletionAcceptanceRepository {
  constructor(private readonly database: DatabaseService) {}

  private async row(
    assetId: string,
    ownerId: string,
  ): Promise<ReceiptRow | undefined> {
    const result = await sql<ReceiptRow>`select ${receiptColumns}
      from public.asset_deletion where asset_id = ${assetId}::uuid
      and owner_id = ${ownerId}::uuid`.execute(this.database.db);
    return result.rows[0];
  }

  async findForOwner(
    assetId: string,
    ownerId: string,
  ): Promise<PublicDeletionReceipt | null> {
    const row = await this.row(assetId, ownerId);
    return row ? publicReceipt(row) : null;
  }

  async existing(
    assetId: string,
    ownerId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<PublicDeletionReceipt | null> {
    const row = await this.row(assetId, ownerId);
    if (!row) return null;
    const version = parseIfMatch(ifMatch, assetId);
    if (version !== row.accepted_lifecycle_version)
      throw new HttpException('Lifecycle version conflict', 412);
    return publicReceipt(row);
  }

  async candidate(
    assetId: string,
    ownerId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<AssetCandidate> {
    const result =
      await sql<AssetCandidate>`select id, lifecycle_version::text as lifecycle_version, trashed_at, mime_type
      from public.asset where id = ${assetId}::uuid and owner_id = ${ownerId}::uuid`.execute(
        this.database.db,
      );
    const asset = result.rows[0];
    if (!asset) throw new NotFoundException('Asset not found');
    const version = parseIfMatch(ifMatch, assetId);
    if (version !== asset.lifecycle_version)
      throw new HttpException('Lifecycle version conflict', 412);
    if (asset.trashed_at === null)
      throw new HttpException('Asset must be in Trash', 409);
    return asset;
  }

  async accept(
    actor: AuthenticatedActor,
    assetId: string,
    ifMatch: string | string[] | undefined,
    verified: StorageBinding,
  ): Promise<AcceptanceResult> {
    let entered = false;
    let callbackAbort: CallbackAbort | undefined;
    let expected: AcceptedTarget | undefined;
    try {
      const outcome = await this.database.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (transaction) => {
          entered = true;
          try {
            // The journal must survive a database crash before any file I/O.
            // Keep the setting on this transaction's connection through COMMIT.
            await sql`set local synchronous_commit to on`.execute(transaction);
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
            const locked =
              await sql<AssetCandidate>`select id, lifecycle_version::text as lifecycle_version, trashed_at, mime_type
            from public.asset where id = ${assetId}::uuid and owner_id = ${actor.userId}::uuid
            for update`.execute(transaction);
            const validity = await sql<{
              valid: boolean;
            }>`select expires_at > clock_timestamp() as valid
            from public.auth_session where id = ${actor.sessionId}::uuid
            and user_id = ${actor.userId}::uuid`.execute(transaction);
            if (!validity.rows[0]?.valid)
              throw new UnauthorizedException('Unauthorized');
            if (user.password_change_required)
              throw new ForbiddenException('Forbidden');
            const asset = locked.rows[0];
            if (!asset) {
              const existing =
                await sql<ReceiptRow>`select ${receiptColumns} from public.asset_deletion
              where asset_id = ${assetId}::uuid and owner_id = ${actor.userId}::uuid`.execute(
                  transaction,
                );
              if (!existing.rows[0])
                throw new NotFoundException('Asset not found');
              const version = parseIfMatch(ifMatch, assetId);
              if (version !== existing.rows[0].accepted_lifecycle_version)
                throw new HttpException('Lifecycle version conflict', 412);
              return {
                status: 'existing' as const,
                receipt: publicReceipt(existing.rows[0]),
              };
            }
            const version = parseIfMatch(ifMatch, assetId);
            if (version !== asset.lifecycle_version)
              throw new HttpException('Lifecycle version conflict', 412);
            if (asset.trashed_at === null)
              throw new HttpException('Asset must be in Trash', 409);
            const anchor = await transaction
              .selectFrom('storage_binding')
              .selectAll()
              .where('singleton', '=', true)
              .forShare()
              .executeTakeFirst();
            if (
              !anchor ||
              anchor.storage_id !== verified.storage_id ||
              anchor.originals_binding_id !== verified.originals_binding_id ||
              anchor.thumbnails_binding_id !== verified.thumbnails_binding_id ||
              anchor.storage_layout_version !== 1 ||
              anchor.storage_layout_version !== verified.storage_layout_version
            )
              throw new ServiceUnavailableException('Service unavailable');
            const afterBinding = await sql<{
              valid: boolean;
            }>`select expires_at > clock_timestamp() as valid
            from public.auth_session where id = ${actor.sessionId}::uuid
            and user_id = ${actor.userId}::uuid`.execute(transaction);
            if (!afterBinding.rows[0]?.valid)
              throw new UnauthorizedException('Unauthorized');
            const extension =
              asset.mime_type === 'image/jpeg'
                ? '.jpg'
                : asset.mime_type === 'image/png'
                  ? '.png'
                  : asset.mime_type === 'image/webp'
                    ? '.webp'
                    : null;
            if (!extension)
              throw new ServiceUnavailableException('Service unavailable');
            expected = {
              assetId,
              ownerId: actor.userId,
              version,
              storage: anchor,
              extension,
            };
            await transaction
              .insertInto('asset_deletion')
              .values({
                asset_id: assetId,
                owner_id: actor.userId,
                accepted_lifecycle_version: version,
                storage_id: anchor.storage_id,
                originals_binding_id: anchor.originals_binding_id,
                thumbnails_binding_id: anchor.thumbnails_binding_id,
                storage_layout_version: anchor.storage_layout_version,
                original_extension: extension,
                requested_at: sql<Date>`clock_timestamp()`,
                completed_at: null,
                last_error_code: null,
                execution_token: null,
                execution_expires_at: null,
              })
              .execute();
            await transaction
              .deleteFrom('asset')
              .where('id', '=', assetId)
              .where('owner_id', '=', actor.userId)
              .execute();
            return { status: 'committed' as const };
          } catch (error: unknown) {
            callbackAbort = new CallbackAbort(error);
            throw callbackAbort;
          }
        });
      if (outcome.status === 'existing') return outcome;
      // COMMIT was acknowledged. A separate read also supplies exact timestamp text.
      const receipt = await this.findForOwner(assetId, actor.userId);
      if (!receipt)
        throw new ServiceUnavailableException('Service unavailable');
      return { status: 'committed', receipt };
    } catch (error: unknown) {
      if (!entered) return { status: 'not_started', error };
      if (callbackAbort && error === callbackAbort)
        return { status: 'rolled_back', error: callbackAbort.original };
      if (!expected)
        return {
          status: 'uncertain',
          expected: {
            assetId,
            ownerId: actor.userId,
            version: '',
            storage: verified,
            extension: '',
          },
        };
      return { status: 'uncertain', expected };
    }
  }

  async confirmUncertain(
    target: AcceptedTarget,
  ): Promise<PublicDeletionReceipt | null> {
    if (!target.version || !target.extension) return null;
    const row = await this.row(target.assetId, target.ownerId);
    if (
      !row ||
      row.accepted_lifecycle_version !== target.version ||
      row.original_extension !== target.extension ||
      row.storage_id !== target.storage.storage_id ||
      row.originals_binding_id !== target.storage.originals_binding_id ||
      row.thumbnails_binding_id !== target.storage.thumbnails_binding_id ||
      row.storage_layout_version !== target.storage.storage_layout_version
    )
      return null;
    return publicReceipt(row);
  }

  async assertCurrentActor(actor: AuthenticatedActor): Promise<void> {
    await this.database.db
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
        const validity = await sql<{
          valid: boolean;
        }>`select expires_at > clock_timestamp() as valid
        from public.auth_session where id = ${actor.sessionId}::uuid and user_id = ${actor.userId}::uuid`.execute(
          transaction,
        );
        if (!validity.rows[0]?.valid)
          throw new UnauthorizedException('Unauthorized');
        if (user.password_change_required)
          throw new ForbiddenException('Forbidden');
      });
  }
}
