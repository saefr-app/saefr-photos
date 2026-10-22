import { Injectable } from '@nestjs/common';

export class AttemptLimitError extends Error {
  readonly retryAfter = 900;
}

/** Bounded, single-process policy. A restart resets counters. */
@Injectable()
export class AttemptLimiter {
  private readonly entries = new Map<
    string,
    { count: number; until: number }
  >();

  take(source: string, username: string, category: 'login' | 'reauth'): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.until <= now) this.entries.delete(key);
    }
    const keys = [
      [`${category}:ip:${source}`, 30] as const,
      [`${category}:name:${username}`, 10] as const,
    ];
    if (keys.some(([key, max]) => (this.entries.get(key)?.count ?? 0) >= max))
      throw new AttemptLimitError();
    if (
      this.entries.size +
        keys.filter(([key]) => !this.entries.has(key)).length >
      2048
    )
      throw new AttemptLimitError();
    for (const [key] of keys) {
      const entry = this.entries.get(key);
      this.entries.set(
        key,
        entry
          ? { count: entry.count + 1, until: entry.until }
          : { count: 1, until: now + 900_000 },
      );
    }
  }
}
