import { Readable } from 'node:stream';

import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { LocalStorageService } from '../storage/local-storage.service.js';
import type { AssetsRepository } from './assets.repository.js';
import { AssetsService } from './assets.service.js';
import type { AuthenticatedActor } from '../auth/auth-session.service.js';

const actor: AuthenticatedActor = {
  userId: '00000000-0000-4000-8000-000000000100',
  username: 'owner',
  role: 'user',
  sessionId: '00000000-0000-4000-8000-000000000200',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  passwordChangeRequired: false,
  csrfToken: Buffer.alloc(32),
};

describe('AssetsService uploads', () => {
  function setup() {
    const saveImage = vi.fn().mockResolvedValue({
      storagePath: '/storage/originals/new.jpg',
      mimeType: 'image/jpeg',
      size: 128,
    });

    const deleteImage = vi.fn().mockResolvedValue(undefined);

    const createForActor = vi
      .fn()
      .mockImplementation(async (_actor, asset) => ({
        status: 'committed',
        asset,
      }));

    const repository = {
      createForActor,
    } as unknown as AssetsRepository;

    const storage = {
      saveImage,
      deleteImage,
    } as unknown as LocalStorageService;

    return {
      service: new AssetsService(repository, storage),
      saveImage,
      deleteImage,
      createForActor,
    };
  }

  it('stores an image and creates database metadata', async () => {
    const { service, saveImage, createForActor } = setup();

    const result = await service.upload(actor, {
      filename: 'holiday.jpg',
      mimeType: 'image/jpeg',
      stream: Readable.from([Buffer.from('image')]),
    });

    expect(result.filename).toBe('holiday.jpg');
    expect(result.mime_type).toBe('image/jpeg');
    expect(result.size).toBe(128);
    expect(result.id).toBeTruthy();

    expect(saveImage).toHaveBeenCalledOnce();
    expect(createForActor).toHaveBeenCalledOnce();
    expect(createForActor).toHaveBeenCalledWith(
      actor,
      expect.not.objectContaining({ owner_id: expect.anything() }),
    );
  });

  it('cleans up files when database insertion fails', async () => {
    const { service, createForActor, deleteImage } = setup();

    createForActor.mockResolvedValueOnce({
      status: 'rolled_back',
      error: new Error('Database unavailable'),
    });

    await expect(
      service.upload(actor, {
        filename: 'holiday.jpg',
        mimeType: 'image/jpeg',
        stream: Readable.from([Buffer.from('image')]),
      }),
    ).rejects.toThrow('Database unavailable');

    expect(deleteImage).toHaveBeenCalledWith(expect.any(String), 'image/jpeg');
  });

  it('sanitizes a pre-callback failure without replacing its cause on cleanup failure', async () => {
    const { service, createForActor, deleteImage } = setup();
    const original = new Error('private database connection detail');
    createForActor.mockResolvedValueOnce({
      status: 'not_started',
      error: original,
    });
    deleteImage.mockRejectedValueOnce(new Error('private storage path'));

    const failure: unknown = await service
      .upload(actor, {
        filename: 'holiday.jpg',
        mimeType: 'image/jpeg',
        stream: Readable.from([Buffer.from('image')]),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect(failure).toMatchObject({ status: 503, cause: original });
    expect(
      JSON.stringify((failure as ServiceUnavailableException).getResponse()),
    ).not.toContain('private');
    expect(deleteImage).toHaveBeenCalledOnce();
  });

  it('retains both published files when commit acknowledgement is uncertain', async () => {
    const { service, createForActor, deleteImage } = setup();
    createForActor.mockResolvedValueOnce({
      status: 'uncertain',
      error: new Error('private database connection detail'),
    });

    await expect(
      service.upload(actor, {
        filename: 'holiday.jpg',
        mimeType: 'image/jpeg',
        stream: Readable.from([Buffer.from('image')]),
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(createForActor).toHaveBeenCalledOnce();
    expect(deleteImage).not.toHaveBeenCalled();
  });

  it('retains files after an acknowledged commit even if response conversion fails', async () => {
    const { service, createForActor, deleteImage } = setup();
    createForActor.mockImplementationOnce(async (_actor, asset) => ({
      status: 'committed',
      asset: { ...asset, created_at: null },
    }));

    await expect(
      service.upload(actor, {
        filename: 'holiday.jpg',
        mimeType: 'image/jpeg',
        stream: Readable.from([Buffer.from('image')]),
      }),
    ).rejects.toThrow();
    expect(deleteImage).not.toHaveBeenCalled();
  });

  it('preserves the database error if best-effort cleanup fails', async () => {
    const { service, createForActor, deleteImage } = setup();
    const original = new Error('simulated rollback failure');
    createForActor.mockResolvedValueOnce({
      status: 'rolled_back',
      error: original,
    });
    deleteImage.mockRejectedValueOnce(new Error('private storage path'));

    await expect(
      service.upload(actor, {
        filename: 'holiday.jpg',
        mimeType: 'image/jpeg',
        stream: Readable.from([Buffer.from('image')]),
      }),
    ).rejects.toBe(original);
    expect(deleteImage).toHaveBeenCalledOnce();
  });

  it('rejects invalid filenames', async () => {
    const { service, saveImage } = setup();

    await expect(
      service.upload(actor, {
        filename: '',
        mimeType: 'image/jpeg',
        stream: Readable.from([Buffer.from('image')]),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(saveImage).not.toHaveBeenCalled();
  });
});
