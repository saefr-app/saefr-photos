import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient, type PoolConfig } from 'pg';
import type {
  PostgresCursor,
  PostgresPool,
  PostgresPoolClient,
  PostgresQueryResult,
} from 'kysely';
import { RecoveryPermitError } from './recovery-permit.js';

export const PERMIT_DATABASE_LIMITS = {
  connect: 2000,
  receive: 3000,
  dispose: 1000,
  confirm: 2000,
} as const;
const failed = () => new RecoveryPermitError('pairing_unavailable');
interface Identity {
  pid: number;
  started: string;
}
interface Session {
  client: PoolClient;
  identity?: Identity;
  borrowed: boolean;
  retired: boolean;
  ended: boolean;
  end: Promise<void>;
}

async function bounded<T>(
  task: Promise<T>,
  ms: number,
  expire: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            expire();
          } finally {
            reject(failed());
          }
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Dedicated read-only permit pool. Retired clients never reenter Kysely or pg's idle pool. */
export class PermitDatabasePool implements PostgresPool {
  readonly options: PoolConfig;
  private readonly pool: Pool;
  private readonly name = `saefr-permit-${randomUUID()}`;
  private readonly sessions = new Map<PoolClient, Session>();
  private readonly uncertain = new Set<Session>();
  private checking?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  private monitorEnd?: Promise<void>;
  private monitorEnded = true;

  constructor(config: PoolConfig) {
    this.options = {
      ...config,
      max: 1,
      pipeline: false,
      application_name: this.name,
      connectionTimeoutMillis: PERMIT_DATABASE_LIMITS.connect,
      // Our deadline retires the socket before rejecting. pg's query_timeout alone does not.
      query_timeout: 0,
      keepAlive: true,
      keepAliveInitialDelayMillis: 1000,
    };
    this.pool = new Pool(this.options);
    this.pool.on('connect', (client) => {
      let resolveEnd!: () => void;
      const session: Session = {
        client,
        borrowed: false,
        retired: false,
        ended: false,
        end: new Promise<void>((resolve) => {
          resolveEnd = resolve;
        }),
      };
      this.sessions.set(client, session);
      client.once('end', () => {
        session.ended = true;
        resolveEnd();
        this.sessions.delete(client);
      });
      // Installed before pg hands the client to a borrower, not just while idle.
      client.on('error', () => {
        this.retire(session);
        console.error('Recovery permit database connection unavailable.');
      });
    });
    this.pool.on('error', () =>
      console.error('Recovery permit database unavailable.'),
    );
  }

  diagnostics() {
    return {
      unconfirmedSessions: this.uncertain.size,
      pendingLocalDisposals: [...this.uncertain].filter((s) => !s.ended).length,
      monitorDisposalPending: !this.monitorEnded,
      closed: this.stopped,
    };
  }

  async connect(): Promise<PostgresPoolClient> {
    if (this.stopped) throw failed();
    await this.confirmRetirements();
    if (this.stopped) throw failed();
    const client = await this.pool.connect().catch(() => {
      throw failed();
    }); // pg bounds both connection and checkout wait.
    const state = this.sessions.get(client)!;
    state.borrowed = true;
    if (this.stopped || this.uncertain.size || state.retired) {
      this.retire(state);
      throw failed();
    }
    const wrapper = new PermitConnection(this, state);
    try {
      // Obtain exact server identity BEFORE any advisory lock or caller SQL can be submitted.
      const result = await wrapper.query<{ pid: number; started: string }>(
        `select pid, to_char(backend_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started
         from pg_stat_activity where pid = pg_backend_pid()`,
        [],
      );
      if (!result.rows[0] || !Number.isSafeInteger(result.rows[0].pid))
        throw failed();
      state.identity = result.rows[0];
      return wrapper;
    } catch {
      this.retire(state);
      await this.awaitLocal(state);
      throw failed();
    }
  }

  async query<R>(
    state: Session,
    sql: string,
    parameters: readonly unknown[],
  ): Promise<PostgresQueryResult<R>> {
    if (this.stopped || state.retired || this.uncertain.size) throw failed();
    try {
      const result = await bounded(
        state.client.query(sql, [...parameters]),
        PERMIT_DATABASE_LIMITS.receive,
        () => this.retire(state),
      );
      if (state.retired || this.stopped) throw failed();
      return {
        command: result.command as PostgresQueryResult<R>['command'],
        rowCount: result.rowCount ?? 0,
        rows: result.rows as R[],
      };
    } catch {
      this.retire(state);
      await this.awaitLocal(state);
      throw failed();
    }
  }

  release(state: Session): void {
    if (!state.borrowed) return;
    state.borrowed = false;
    state.client.release(state.retired || this.stopped);
  }

  private retire(state: Session): void {
    if (state.retired) return;
    state.retired = true;
    this.uncertain.add(state);
    if (state.borrowed) {
      state.borrowed = false;
      // Supported pg-pool destroy release. In pinned pg, end() destroys an active non-pipelined socket.
      try {
        state.client.release(true);
      } catch {
        // Preserve quarantine even if pool bookkeeping cannot acknowledge disposal.
        void state.client.end().catch(() => undefined);
      }
    } else {
      // Idle error/removal may already have started end(); the preinstalled end event tracks disposal.
      void state.client.end().catch(() => undefined);
    }
  }

  private async awaitLocal(state: Session): Promise<void> {
    await bounded(
      state.end,
      PERMIT_DATABASE_LIMITS.dispose,
      () => undefined,
    ).catch(() => undefined);
  }

  private confirmRetirements(): Promise<void> {
    if (!this.uncertain.size && this.monitorEnded) return Promise.resolve();
    if (this.checking) return this.checking;
    this.checking = this.confirm().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async confirm(): Promise<void> {
    if (this.monitorEnd && !this.monitorEnded) {
      await bounded(
        this.monitorEnd,
        PERMIT_DATABASE_LIMITS.dispose,
        () => undefined,
      );
    }
    const retired = [...this.uncertain];
    if (retired.some((session) => !session.ended)) throw failed();
    if (!retired.length) return;
    // This separate connection never obtains advisory locks or grants authorization.
    const client = new Client({
      ...this.options,
      application_name: `saefr-permit-proof-${randomUUID()}`,
      statement_timeout: PERMIT_DATABASE_LIMITS.confirm,
    });
    client.on('error', () => undefined); // query/connect rejection is handled below, never logged raw.
    let end: Promise<void> | undefined;
    const dispose = () => {
      if (!end) {
        this.monitorEnded = false;
        end = client.end().then(() => {
          this.monitorEnded = true;
        });
        this.monitorEnd = end;
      }
    };
    try {
      await client.connect();
      for (const session of retired) {
        const result = await bounded(
          client.query<{ present: boolean }>(
            `select exists(select 1 from pg_stat_activity where application_name = $1
             and ($2::integer is null or (pid = $2 and backend_start = $3::timestamptz))) as present`,
            [
              this.name,
              session.identity?.pid ?? null,
              session.identity?.started ?? null,
            ],
          ),
          PERMIT_DATABASE_LIMITS.confirm,
          dispose,
        );
        if (result.rows[0]?.present !== false) throw failed();
      }
      dispose();
      await bounded(end!, PERMIT_DATABASE_LIMITS.dispose, () => undefined);
      // Only a positively received absence read plus local disposal clears this fence.
      for (const session of retired) this.uncertain.delete(session);
    } finally {
      dispose();
      await bounded(
        end!,
        PERMIT_DATABASE_LIMITS.dispose,
        () => undefined,
      ).catch(() => undefined);
    }
  }

  end(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async () => {
      for (const state of this.sessions.values())
        if (state.borrowed) this.retire(state);
      await bounded(
        this.pool.end(),
        PERMIT_DATABASE_LIMITS.dispose,
        () => undefined,
      );
      await this.confirmRetirements(); // local close alone is not remote quiescence evidence.
    })();
    return this.closing;
  }
}

class PermitConnection implements PostgresPoolClient {
  constructor(
    private readonly owner: PermitDatabasePool,
    private readonly state: Session,
  ) {}
  query<R>(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<PostgresQueryResult<R>>;
  query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
  query<R>(
    sql: string | PostgresCursor<R>,
    parameters: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
    if (typeof sql !== 'string') throw failed(); // permit validation never streams cursors
    return this.owner.query<R>(this.state, sql, parameters);
  }
  release(): void {
    this.owner.release(this.state);
  }
}
