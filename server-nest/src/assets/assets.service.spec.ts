import { Readable } from 'node:stream';

import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { LocalStorageService } from '../storage/local-storage.service.js';
import type { AssetsRepository } from './assets.repository.js';
import { AssetsService } from './assets.service.js';

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
    const repository = {
      findAll: vi.fn().mockResolvedValue([asset]),
    } as unknown as AssetsRepository;

    const { storage } = createStorageMock();
    const service = new AssetsService(repository, storage);

    await expect(service.findAll()).resolves.toEqual([
      {
        id: asset.id,
        filename: asset.filename,
        mime_type: asset.mime_type,
        size: asset.size,
        created_at: '2026-10-15T12:00:00.000Z',
      },
    ]);
  });

  it('returns one asset by UUID', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(asset),
    } as unknown as AssetsRepository;

    const { storage } = createStorageMock();
    const service = new AssetsService(repository, storage);

    await expect(service.findById(asset.id)).resolves.toMatchObject({
      id: asset.id,
      filename: 'holiday.jpg',
    });
  });

  it('throws 404 when an asset does not exist', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(undefined),
    } as unknown as AssetsRepository;

    const { storage } = createStorageMock();
    const service = new AssetsService(repository, storage);

    await expect(
      service.findById('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('opens an original image through the storage service', async () => {
    const repository = {
      findFileById: vi.fn().mockResolvedValue(asset),
    } as unknown as AssetsRepository;

    const { storage, openOriginal } = createStorageMock();
    const service = new AssetsService(repository, storage);

    const file = await service.getOriginal(asset.id);

    expect(file.contentType).toBe('image/jpeg');
    expect(file.size).toBe(8);

    expect(openOriginal).toHaveBeenCalledWith(
      asset.id,
      asset.mime_type,
      asset.storage_path,
    );

    file.stream.destroy();
  });

  it('opens thumbnails as JPEG files', async () => {
    const repository = {
      findFileById: vi.fn().mockResolvedValue(asset),
    } as unknown as AssetsRepository;

    const { storage, openThumbnail } = createStorageMock();
    const service = new AssetsService(repository, storage);

    const file = await service.getThumbnail(asset.id);

    expect(file.contentType).toBe('image/jpeg');
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
      service.getOriginal('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(openOriginal).not.toHaveBeenCalled();
  });
});
