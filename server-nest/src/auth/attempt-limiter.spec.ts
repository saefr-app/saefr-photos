import { describe, expect, it, vi } from 'vitest';

import { AttemptLimiter, AttemptLimitError } from './attempt-limiter.js';

describe('AttemptLimiter', () => {
  it('bounds per-name and source attempts and resets after the fixed window', () => {
    vi.useFakeTimers();
    try {
      const limiter = new AttemptLimiter();
      for (let index = 0; index < 10; index++)
        limiter.take(`127.0.0.${index}`, 'alice', 'login');
      expect(() => limiter.take('127.0.0.11', 'alice', 'login')).toThrow(
        AttemptLimitError,
      );
      limiter.take('127.0.0.11', 'bob', 'login');
      vi.advanceTimersByTime(900_001);
      expect(() => limiter.take('127.0.0.11', 'alice', 'login')).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps login and reauthentication counters separate', () => {
    const limiter = new AttemptLimiter();
    for (let index = 0; index < 30; index++)
      limiter.take('127.0.0.1', `name${index}`, 'login');
    expect(() => limiter.take('127.0.0.1', 'next', 'login')).toThrow(
      AttemptLimitError,
    );
    expect(() => limiter.take('127.0.0.1', 'next', 'reauth')).not.toThrow();
  });
});
