import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../database/database.service.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('returns application health information', () => {
    const database = {
      ping: vi.fn(),
    } as unknown as DatabaseService;

    const service = new HealthService(database);

    expect(service.getHealth()).toEqual({
      status: 'ok',
      service: 'saefr-photos',
    });

    expect(database.ping).not.toHaveBeenCalled();
  });

  it('returns ready when PostgreSQL responds', async () => {
    const database = {
      ping: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseService;

    const service = new HealthService(database);

    await expect(service.getReadiness()).resolves.toEqual({
      status: 'ok',
      database: 'connected',
    });
  });

  it('throws when PostgreSQL is unavailable', async () => {
    const database = {
      ping: vi.fn().mockRejectedValue(
        new Error('Connection refused'),
      ),
    } as unknown as DatabaseService;

    const service = new HealthService(database);

    await expect(service.getReadiness()).rejects.toMatchObject({
      status: 503,
    });
  });
});
