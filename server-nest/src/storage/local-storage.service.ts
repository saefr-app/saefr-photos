import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { Readable } from 'node:stream';

import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface StoredFile {
  stream: Readable;
  size: number;
}

type StorageDirectory = 'originals' | 'thumbnails';

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;

  return code === 'ENOENT'
    || code === 'ENOTDIR'
    || code === 'ELOOP';
}

@Injectable()
export class LocalStorageService {
  private readonly storageRoot: string;

  constructor(config: ConfigService) {
    this.storageRoot = resolve(
      config.get<string>('STORAGE_ROOT')
        ?? resolve(process.cwd(), '../storage'),
    );
  }

  async openOriginal(
    assetId: string,
    mimeType: string,
    legacyStoragePath: string,
  ): Promise<StoredFile> {
    const extension = IMAGE_EXTENSIONS[mimeType];

    if (!extension) {
      throw new NotFoundException('Asset file not found');
    }

    const filename = `${assetId}${extension}`;

    if (basename(legacyStoragePath) !== filename) {
      throw new NotFoundException('Asset file not found');
    }

    return this.openFile('originals', filename);
  }

  async openThumbnail(
    assetId: string,
  ): Promise<StoredFile> {
    return this.openFile(
      'thumbnails',
      `${assetId}.jpg`,
    );
  }

  private async openFile(
    directoryName: StorageDirectory,
    filename: string,
  ): Promise<StoredFile> {
    let handle: FileHandle | undefined;

    try {
      const root = await realpath(this.storageRoot);

      const directory = await realpath(
        join(this.storageRoot, directoryName),
      );

      const relativeDirectory = relative(root, directory);

      if (
        relativeDirectory === '..'
        || relativeDirectory.startsWith(`..${sep}`)
        || isAbsolute(relativeDirectory)
      ) {
        throw new NotFoundException('Asset file not found');
      }

      const filePath = join(directory, filename);

      handle = await open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );

      const stats = await handle.stat();

      if (!stats.isFile()) {
        throw new NotFoundException('Asset file not found');
      }

      return {
        stream: handle.createReadStream({
          autoClose: true,
        }),
        size: stats.size,
      };
    } catch (error: unknown) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }

      if (
        error instanceof NotFoundException
        || isMissingFileError(error)
      ) {
        throw new NotFoundException('Asset file not found');
      }

      throw error;
    }
  }
}
