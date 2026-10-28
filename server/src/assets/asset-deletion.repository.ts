import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql, type Selectable, type Transaction } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import type {
  AssetDeletionTable,
  Database,
} from '../database/database.types.js';

export type DeletionReceipt = Selectable<AssetDeletionTable>;
export type ExecutionAuthority = DeletionReceipt & {
  requested_at_exact: string;
};

export type DeletionErrorCode =
  | 'storage_unavailable'
  | 'storage_identity_mismatch'
  | 'unsupported_storage'
  | 'unexpected_file'
  | 'permission_denied'
  | 'filesystem_error'
  | 'durability_unavailable'
  | 'inconsistent_state'
  | 'unknown_outcome';

export type ClaimResult =
  | { status: 'claimed'; token: string }
  | { status: 'pending' | 'completed' | 'missing' | 'inconsistent' };

/** Durable journal authority and short, token-guarded execution claims. */
@Injectable()
export class AssetDeletionRepository {
  constructor(private readonly database: DatabaseService) {}

  async findForOwner(
    assetId: string,
    ownerId: string,
  ): Promise<DeletionReceipt | undefined> {
    return this.database.db
      .selectFrom('asset_deletion')
      .selectAll()
      .where('asset_id', '=', assetId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
  }

  /** Stable UTC text preserves microseconds that JS Date discards. */
  async findExecutionAuthority(
    assetId: string,
    ownerId: string,
  ): Promise<ExecutionAuthority | undefined> {
    return this.database.db
      .selectFrom('asset_deletion')
      .selectAll()
      .select(
        sql<string>`to_char(requested_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US')`.as('requested_at_exact'),
      )
      .where('asset_id', '=', assetId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
  }

  /** A failed acknowledgement authorizes no I/O without a positive read. */
  async claim(assetId: string, ownerId: string): Promise<ClaimResult> {
    const token = randomUUID();
    try {
      const changed = await sql<{
        asset_id: string;
      }>`update public.asset_deletion d
        set execution_token = ${token}::uuid,
          execution_expires_at = clock_timestamp() + interval '60 seconds',
          last_error_code = null
        where d.asset_id = ${assetId}::uuid and d.owner_id = ${ownerId}::uuid
          and d.completed_at is null
          and (d.execution_token is null or d.execution_expires_at <= clock_timestamp())
          and not exists (select 1 from public.asset a where a.id = d.asset_id)
        returning d.asset_id`.execute(this.database.db);
      if (changed.rows.length === 1) return { status: 'claimed', token };
    } catch (error: unknown) {
      if (await this.confirmClaim(assetId, ownerId, token)) {
        return { status: 'claimed', token };
      }
      throw error;
    }
    const receipt = await this.findForOwner(assetId, ownerId);
    if (!receipt) return { status: 'missing' };
    if (receipt.completed_at) return { status: 'completed' };
    const live = await this.database.db
      .selectFrom('asset')
      .select('id')
      .where('id', '=', assetId)
      .executeTakeFirst();
    return { status: live ? 'inconsistent' : 'pending' };
  }

  async confirmClaim(
    assetId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    const row = await sql<{ valid: boolean }>`select
      d.completed_at is null and d.execution_token = ${token}::uuid
      and d.execution_expires_at > clock_timestamp()
      and not exists (select 1 from public.asset a where a.id = d.asset_id) as valid
      from public.asset_deletion d
      where d.asset_id = ${assetId}::uuid and d.owner_id = ${ownerId}::uuid`.execute(
      this.database.db,
    );
    return row.rows[0]?.valid === true;
  }

  async renew(
    assetId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    return this.updateCurrentClaim(
      assetId,
      ownerId,
      token,
      true,
      async (transaction) => {
        const result = await sql<{
          asset_id: string;
        }>`update public.asset_deletion
          set execution_expires_at = clock_timestamp() + interval '60 seconds'
          where asset_id = ${assetId}::uuid and owner_id = ${ownerId}::uuid
            and completed_at is null and execution_token = ${token}::uuid
            and execution_expires_at > clock_timestamp()
            and not exists (select 1 from public.asset a where a.id = asset_deletion.asset_id)
          returning asset_id`.execute(transaction);
        return result.rows.length === 1;
      },
    );
  }

  /** Call only after both immutable targets and their durability are verified. */
  async completeAfterVerifiedRemoval(
    assetId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    return this.updateCurrentClaim(
      assetId,
      ownerId,
      token,
      true,
      async (transaction) => {
        // A completed receipt must not be acknowledged before its WAL flush.
        await sql`set local synchronous_commit to on`.execute(transaction);
        const result = await sql<{
          asset_id: string;
        }>`update public.asset_deletion
          set completed_at = greatest(clock_timestamp(), requested_at),
            last_error_code = null, execution_token = null, execution_expires_at = null
          where asset_id = ${assetId}::uuid and owner_id = ${ownerId}::uuid
            and completed_at is null and execution_token = ${token}::uuid
            and execution_expires_at > clock_timestamp()
            and not exists (select 1 from public.asset a where a.id = asset_deletion.asset_id)
          returning asset_id`.execute(transaction);
        return result.rows.length === 1;
      },
    );
  }

  /** Caller must have drained its outstanding I/O before releasing a claim. */
  async recordFailure(
    assetId: string,
    ownerId: string,
    token: string,
    code: DeletionErrorCode,
  ): Promise<boolean> {
    return this.updateCurrentClaim(
      assetId,
      ownerId,
      token,
      false,
      async (transaction) => {
        const result = await sql<{
          asset_id: string;
        }>`update public.asset_deletion
          set last_error_code = ${code}, execution_token = null, execution_expires_at = null
          where asset_id = ${assetId}::uuid and owner_id = ${ownerId}::uuid
            and completed_at is null and execution_token = ${token}::uuid
            and execution_expires_at > clock_timestamp()
          returning asset_id`.execute(transaction);
        return result.rows.length === 1;
      },
    );
  }

  private async updateCurrentClaim(
    assetId: string,
    ownerId: string,
    token: string,
    requireAbsentAsset: boolean,
    update: (transaction: Transaction<Database>) => Promise<boolean>,
  ): Promise<boolean> {
    return this.database.db.transaction().execute(async (transaction) => {
      // This query may wait. Evaluate expiry only in the following statement,
      // after PostgreSQL has acquired the journal row lock.
      const locked = await sql<{ asset_id: string }>`select asset_id
        from public.asset_deletion
        where asset_id = ${assetId}::uuid and owner_id = ${ownerId}::uuid
        for update`.execute(transaction);
      if (locked.rows.length !== 1) return false;

      const current = await sql<{ valid: boolean }>`select
        completed_at is null and execution_token = ${token}::uuid
        and execution_expires_at > clock_timestamp()
        and (
          ${!requireAbsentAsset}::boolean or
          not exists (select 1 from public.asset a where a.id = asset_deletion.asset_id)
        ) as valid
        from public.asset_deletion
        where asset_id = ${assetId}::uuid and owner_id = ${ownerId}::uuid`.execute(
        transaction,
      );
      if (current.rows[0]?.valid !== true) return false;
      return update(transaction);
    });
  }
}
