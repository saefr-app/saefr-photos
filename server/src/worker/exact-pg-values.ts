import { sql, type RawBuilder } from 'kysely';

/** PostgreSQL UTC text with all six fractional digits. Never pass through Date. */
export type ExactPgTimestamp = string & {
  readonly __exactPgTimestamp: unique symbol;
};

const UTC_MICROSECOND =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/;
const PG_BIGINT_MAX = 9223372036854775807n;

export function exactPgTimestamp(value: string): ExactPgTimestamp {
  if (!UTC_MICROSECOND.test(value))
    throw new Error('Invalid exact PostgreSQL timestamp');
  return value as ExactPgTimestamp;
}

/** The input remains a bound parameter; PostgreSQL performs every comparison. */
export function pgTimestamp(value: ExactPgTimestamp): RawBuilder<Date> {
  return sql<Date>`${value}::timestamptz`;
}

export function positivePgBigint(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > PG_BIGINT_MAX)
    throw new Error('Invalid positive PostgreSQL bigint');
  return value;
}

export function nonnegativePgBigint(value: string): string {
  if (!/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > PG_BIGINT_MAX)
    throw new Error('Invalid nonnegative PostgreSQL bigint');
  return value;
}

export const PG_BIGINT_LIMIT = PG_BIGINT_MAX.toString();
