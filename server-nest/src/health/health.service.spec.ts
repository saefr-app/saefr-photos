import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../database/database.service.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('returns application health information', () => {
    const ping = vi.fn();

    const database = {
      ping,
    } as unknown as DatabaseService;

    const service = new HealthService(database);

    expect(service.getHealth()).toEqual({
      status: 'ok',
      service: 'saefr-photos',
    });

    expect(ping).not.toHaveBeenCalled();
  });

  it('returns ready when PostgreSQL responds', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);

    const database = {
      ping,
    } as unknown as DatabaseService;

    const service = new HealthService(database);

    await expect(service.getReadiness()).resolves.toEqual({
      status: 'ok',
      database: 'connected',
    });

    expect(ping).toHaveBeenCalledOnce();
  });

  it('throws when PostgreSQL is unavailable', async () => {
    const ping = vi.fn().mockRejectedValue(
      new Error('Connection refused'),
    );

    const database = {
      ping,
    } as unknown as DatabaseService;

    const service = new HealthService(database);

    await expect(service.getReadiness()).rejects.toMatchObject({
      status: 503,
    });

    expect(ping).toHaveBeenCalledOnce();
  });
});
