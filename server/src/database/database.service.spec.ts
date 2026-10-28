import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from './database.service.js';

describe('DatabaseService shutdown', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sanitizes a pool shutdown error before Nest logs it', async () => {
    const service = new DatabaseService(
      new ConfigService({
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: 1,
        POSTGRES_DB: 'saefr_shutdown_test',
        POSTGRES_USER: 'saefr_shutdown_test',
        POSTGRES_PASSWORD: 'fake-test-password',
      }),
    );
    const secret = 'password=private-value';
    const destroy = vi.spyOn(service.db, 'destroy');
    destroy.mockRejectedValueOnce(
      Object.assign(new Error(secret), { code: 'ECONNREFUSED' }),
    );
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});

    await expect(service.onModuleDestroy()).rejects.toThrow(
      'PostgreSQL pool shutdown failed',
    );
    expect(errorLog).toHaveBeenCalledWith(
      'PostgreSQL pool shutdown failed; ECONNREFUSED',
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);

    destroy.mockRestore();
    await service.onModuleDestroy();
  });
});
