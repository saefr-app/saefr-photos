import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AssetsRepository } from './assets.repository.js';
import { AssetsService } from './assets.service.js';

const asset = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  filename: 'holiday.jpg',
  mime_type: 'image/jpeg',
  size: 2450000,
  created_at: new Date('2026-10-15T12:00:00.000Z'),
};

describe('AssetsService', () => {
  it('returns all assets as public metadata', async () => {
    const repository = {
      findAll: vi.fn().mockResolvedValue([asset]),
    } as unknown as AssetsRepository;

    const service = new AssetsService(repository);

    await expect(service.findAll()).resolves.toEqual([
      {
        id: asset.id,
        filename: 'holiday.jpg',
        mime_type: 'image/jpeg',
        size: 2450000,
        created_at: '2026-10-15T12:00:00.000Z',
      },
    ]);
  });

  it('returns one asset by UUID', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(asset),
    } as unknown as AssetsRepository;

    const service = new AssetsService(repository);

    await expect(service.findById(asset.id)).resolves.toMatchObject({
      id: asset.id,
      filename: 'holiday.jpg',
    });
  });

  it('throws 404 when the asset does not exist', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(undefined),
    } as unknown as AssetsRepository;

    const service = new AssetsService(repository);

    await expect(
      service.findById('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
