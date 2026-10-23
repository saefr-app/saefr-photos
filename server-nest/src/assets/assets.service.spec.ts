import { Readable } from 'node:stream';

import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { LocalStorageService } from '../storage/local-storage.service.js';
import type { AssetsRepository } from './assets.repository.js';
import type { AuthenticatedActor } from '../auth/auth-session.service.js';
import { AssetsService } from './assets.service.js';

const actor: AuthenticatedActor = {
  userId: '00000000-0000-4000-8000-000000000100',
  username: 'owner',
  role: 'user',
  sessionId: '00000000-0000-4000-8000-000000000200',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  passwordChangeRequired: false,
  csrfToken: Buffer.alloc(32),
};

const asset = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  filename: 'holiday.jpg',
  mime_type: 'image/jpeg',
  size: 2450000,
  storage_path: '/storage/originals/550e8400-e29b-41d4-a716-446655440000.jpg',
  created_at: new Date('2026-10-15T12:00:00.000Z'),
};

function createStorageMock() {
  const openOriginal = vi.fn().mockImplementation(async () => ({
    stream: Readable.from([Buffer.from('original')]),
    size: 8,
  }));

  const openThumbnail = vi.fn().mockImplementation(async () => ({
    stream: Readable.from([Buffer.from('thumbnail')]),
    size: 9,
  }));

  return {
    storage: {
      openOriginal,
      openThumbnail,
    } as unknown as LocalStorageService,
    openOriginal,
    openThumbnail,
  };
}

describe('AssetsService', () => {
  it('returns all assets as public metadata', async () => {
    const findAll = vi.fn().mockResolvedValue([asset]);
    const repository = {
      findAll,
    } as unknown as AssetsRepository;

    const { storage } = createStorageMock();
    const service = new AssetsService(repository, storage);

    await expect(service.findAll(actor)).resolves.toEqual([
      {
        id: asset.id,
        filename: asset.filename,
        mime_type: asset.mime_type,
        size: asset.size,
        created_at: '2026-10-15T12:00:00.000Z',
      },
    ]);
    expect(findAll).toHaveBeenCalledWith(actor.userId);
  });

  it('returns one asset by UUID', async () => {
    const findById = vi.fn().mockResolvedValue(asset);
    const repository = {
      findById,
    } as unknown as AssetsRepository;

    const { storage } = createStorageMock();
    const service = new AssetsService(repository, storage);

    await expect(service.findById(actor, asset.id)).resolves.toMatchObject({
      id: asset.id,
      filename: 'holiday.jpg',
    });
    expect(findById).toHaveBeenCalledWith(asset.id, actor.userId);
  });

  it('throws 404 when an asset does not exist', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(undefined),
    } as unknown as AssetsRepository;

    const { storage } = createStorageMock();
    const service = new AssetsService(repository, storage);

    await expect(
      service.findById(actor, '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('opens an original image through the storage service', async () => {
    const findFileById = vi.fn().mockResolvedValue(asset);
    const repository = {
      findFileById,
    } as unknown as AssetsRepository;

    const { storage, openOriginal } = createStorageMock();
    const service = new AssetsService(repository, storage);

    const file = await service.getOriginal(actor, asset.id);

    expect(file.contentType).toBe('image/jpeg');
    expect(file.size).toBe(8);
    expect(findFileById).toHaveBeenCalledWith(asset.id, actor.userId);

    expect(openOriginal).toHaveBeenCalledWith(
      asset.id,
      asset.mime_type,
      asset.storage_path,
    );

    file.stream.destroy();
  });

  it('opens thumbnails as JPEG files', async () => {
    const findFileById = vi.fn().mockResolvedValue(asset);
    const repository = {
      findFileById,
    } as unknown as AssetsRepository;

    const { storage, openThumbnail } = createStorageMock();
    const service = new AssetsService(repository, storage);

    const file = await service.getThumbnail(actor, asset.id);

    expect(file.contentType).toBe('image/jpeg');
    expect(findFileById).toHaveBeenCalledWith(asset.id, actor.userId);
    expect(openThumbnail).toHaveBeenCalledWith(asset.id);

    file.stream.destroy();
  });

  it('rejects file requests for unknown assets', async () => {
    const repository = {
      findFileById: vi.fn().mockResolvedValue(undefined),
    } as unknown as AssetsRepository;

    const { storage, openOriginal } = createStorageMock();
    const service = new AssetsService(repository, storage);

    await expect(
      service.getOriginal(actor, '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(openOriginal).not.toHaveBeenCalled();
  });
});
