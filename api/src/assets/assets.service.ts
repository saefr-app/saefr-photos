import { InjectQueue } from '@nestjs/bullmq';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, ReadStream } from 'fs';
import { promises as fs } from 'fs';
import { dirname, join, basename, resolve, sep } from 'path';
import { In, Repository } from 'typeorm';
import { Asset } from '../entities/asset.entity';
import { LibraryMembership } from '../entities/library-membership.entity';
import { User } from '../entities/user.entity';
import {
  ASSET_PROCESSING_QUEUE,
  PROCESS_ASSET_JOB,
  ProcessAssetJobData,
} from '../queue/queue.constants';

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly uploadsDir: string;

  constructor(
    @InjectRepository(Asset)
    private readonly assets: Repository<Asset>,
    @InjectRepository(LibraryMembership)
    private readonly memberships: Repository<LibraryMembership>,
    @InjectQueue(ASSET_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessAssetJobData>,
    config: ConfigService,
  ) {
    this.uploadsDir = config.get<string>('UPLOADS_DIR', '/app/uploads');
  }

  async upload(user: User, file: Express.Multer.File): Promise<Asset> {
    const libraryId = await this.resolveUploadLibraryId(user.id);

    // Two different names, on purpose:
    //   originalFilename — what the user's device called it, kept verbatim for
    //     display. Spaces, accents, Devanagari and so on all survive.
    //   storageKey       — the on-disk path, aggressively sanitised. Client
    //     filenames are untrusted, so a name like "../../etc/passwd" must not
    //     be able to escape the uploads volume.
    const originalFilename = this.decodeFilename(file.originalname);
    const safeName = this.sanitiseFilename(originalFilename);
    const storageKey = `${libraryId}/${randomUUID()}-${safeName}`;
    const absolutePath = join(this.uploadsDir, storageKey);

    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, file.buffer);

    const checksum = createHash('sha1').update(file.buffer).digest('hex');

    // Checksum is captured but deliberately NOT enforced yet. Turning on
    // deduplication later is one lookup here:
    //   const dupe = await this.assets.findOne({ where: { checksum, libraryId } });
    //   if (dupe) { /* drop the new file, return the existing row */ }

    const asset = await this.assets.save(
      this.assets.create({
        libraryId,
        uploadedBy: user.id,
        storageKey,
        originalFilename,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        checksum,
        status: 'uploaded',
      }),
    );

    await this.queue.add(PROCESS_ASSET_JOB, {
      assetId: asset.id,
      storageKey: asset.storageKey,
    });

    this.logger.log(`Stored asset ${asset.id} at ${storageKey}, queued for processing`);

    // Returned immediately — the caller does not wait for the job to run.
    return asset;
  }

  /**
   * Authorisation happens here, and only here: an asset is visible to anyone
   * holding a LibraryMembership for its library. A caller without membership
   * gets 404, never 403 — a 403 would confirm the asset exists.
   */
  async findOneForUser(user: User, assetId: string): Promise<Asset> {
    const asset = await this.assets.findOne({ where: { id: assetId } });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const membership = await this.memberships.findOne({
      where: { userId: user.id, libraryId: asset.libraryId },
    });
    if (!membership) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  /**
   * Everything in every library the caller belongs to, newest first. Membership
   * is the filter, which is what makes a shared library "just work" here later
   * without any per-asset ownership check.
   */
  async listForUser(user: User): Promise<Asset[]> {
    const memberships = await this.memberships.find({
      where: { userId: user.id },
    });
    if (memberships.length === 0) {
      return [];
    }

    // Hard cap instead of real pagination — fine while libraries are small,
    // needs cursor pagination before anyone has a real photo roll.
    return this.assets.find({
      where: { libraryId: In(memberships.map((m) => m.libraryId)) },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  /**
   * Opens the stored file for reading. Access is resolved through
   * findOneForUser, so the same membership rule that guards the metadata guards
   * the bytes.
   */
  async openFile(
    user: User,
    assetId: string,
  ): Promise<{ asset: Asset; stream: ReadStream }> {
    const asset = await this.findOneForUser(user, assetId);

    const absolutePath = resolve(join(this.uploadsDir, asset.storageKey));

    // storageKey is server-generated, so this should never trip — it's here so
    // that a future bug elsewhere can't turn into arbitrary file reads.
    const root = resolve(this.uploadsDir);
    if (absolutePath !== root && !absolutePath.startsWith(root + sep)) {
      this.logger.error(`Refusing to serve out-of-root path for ${assetId}`);
      throw new NotFoundException('Asset not found');
    }

    try {
      await fs.access(absolutePath);
    } catch {
      // Row exists but the file is gone — a real possibility today, since an
      // upload that fails after the write leaves no cleanup path.
      this.logger.error(`Asset ${assetId} row exists but file is missing`);
      throw new NotFoundException('Asset file not found');
    }

    return { asset, stream: createReadStream(absolutePath) };
  }

  /**
   * Every user gets exactly one personal library at signup, so the upload
   * target is unambiguous for now. Choosing between multiple libraries (an
   * explicit libraryId on the request) comes with the sharing work.
   */
  private async resolveUploadLibraryId(userId: string): Promise<string> {
    const memberships = await this.memberships.find({ where: { userId } });
    const writable = memberships.find(
      (m) => m.role === 'owner' || m.role === 'contributor',
    );

    if (!writable) {
      throw new ForbiddenException('No library available to upload to');
    }

    return writable.libraryId;
  }

  /**
   * busboy (under Multer) decodes non-RFC2231 filenames as latin1, which turns
   * any non-ASCII name into mojibake. Re-reading those bytes as UTF-8 restores
   * it; for pure-ASCII names the conversion is a no-op.
   */
  private decodeFilename(name: string): string {
    const raw = Buffer.from(name ?? '', 'latin1').toString('utf8');
    return raw.slice(0, 255) || 'upload';
  }

  /** Path-safe form of a filename — used for the storage key only, never for display. */
  private sanitiseFilename(name: string): string {
    const base = basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
    const trimmed = base.replace(/^\.+/, '').slice(0, 128);
    return trimmed.length > 0 ? trimmed : 'upload';
  }
}
