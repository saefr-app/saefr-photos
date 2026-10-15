import { Readable } from 'node:stream';

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { LocalStorageService } from '../storage/local-storage.service.js';
import type { AssetsRepository } from './assets.repository.js';
import { AssetsService } from './assets.service.js';

describe('AssetsService uploads', () => {
  function setup() {
    const saveImage = vi.fn().mockResolvedValue({
      storagePath: '/storage/originals/new.jpg',
      mimeType: 'image/jpeg',
      size: 128,
    });

    const deleteImage = vi.fn().mockResolvedValue(undefined);

    const create = vi.fn().mockImplementation(async (asset) => asset);

    const repository = {
      create,
    } as unknown as AssetsRepository;

    const storage = {
      saveImage,
      deleteImage,
    } as unknown as LocalStorageService;

    return {
      service: new AssetsService(repository, storage),
      saveImage,
      deleteImage,
      create,
    };
  }

  it('stores an image and creates database metadata', async () => {
    const { service, saveImage, create } = setup();

    const result = await service.upload({
      filename: 'holiday.jpg',
      mimeType: 'image/jpeg',
      stream: Readable.from([Buffer.from('image')]),
    });

    expect(result.filename).toBe('holiday.jpg');
    expect(result.mime_type).toBe('image/jpeg');
    expect(result.size).toBe(128);
    expect(result.id).toBeTruthy();

    expect(saveImage).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });

  it('cleans up files when database insertion fails', async () => {
    const { service, create, deleteImage } = setup();

    create.mockRejectedValueOnce(new Error('Database unavailable'));

    await expect(
      service.upload({
        filename: 'holiday.jpg',
        mimeType: 'image/jpeg',
        stream: Readable.from([Buffer.from('image')]),
      }),
    ).rejects.toThrow('Database unavailable');

    expect(deleteImage).toHaveBeenCalledWith(expect.any(String), 'image/jpeg');
  });

  it('rejects invalid filenames', async () => {
    const { service, saveImage } = setup();

    await expect(
      service.upload({
        filename: '',
        mimeType: 'image/jpeg',
        stream: Readable.from([Buffer.from('image')]),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(saveImage).not.toHaveBeenCalled();
  });
});
