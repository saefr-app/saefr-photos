import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { sql, type Insertable, type Selectable } from 'kysely';

import type { AuthenticatedActor } from '../auth/auth-session.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { AssetTable } from '../database/database.types.js';
import {
  assertAssetIdNotRetiredIfPresent,
  lockAssetId,
} from './asset-id-coordination.js';

export type AssetRecord = Pick<
  Selectable<AssetTable>,
  'id' | 'filename' | 'mime_type' | 'size' | 'created_at'
>;

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

  async findAll(ownerId: string): Promise<AssetRecord[]> {
    return this.database.db
      .selectFrom('asset')
      .select(['id', 'filename', 'mime_type', 'size', 'created_at'])
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  async findById(
    assetId: string,
    ownerId: string,
  ): Promise<AssetRecord | undefined> {
    return this.database.db
      .selectFrom('asset')
      .select(['id', 'filename', 'mime_type', 'size', 'created_at'])
      .where('id', '=', assetId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
  }

  async findFileById(
    assetId: string,
    ownerId: string,
  ): Promise<AssetFileRecord | undefined> {
    return this.database.db
      .selectFrom('asset')
      .select(['id', 'mime_type', 'storage_path'])
      .where('id', '=', assetId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
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
      return { status: 'committed', asset: created };
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
