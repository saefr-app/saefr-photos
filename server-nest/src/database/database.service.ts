import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { Database } from './database.types.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  readonly db: Kysely<Database>;

  constructor(private readonly config: ConfigService) {
    const pool = new Pool({
      host: this.config.getOrThrow<string>('POSTGRES_HOST'),
      port: this.config.getOrThrow<number>('POSTGRES_PORT'),
      database: this.config.getOrThrow<string>('POSTGRES_DB'),
      user: this.config.getOrThrow<string>('POSTGRES_USER'),
      password: this.config.getOrThrow<string>('POSTGRES_PASSWORD'),
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });

    pool.on('error', () => {
      this.logger.error('Unexpected PostgreSQL idle client error');
    });

    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool,
      }),
    });
  }

  async ping(): Promise<void> {
    await sql`SELECT 1`.execute(this.db);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
