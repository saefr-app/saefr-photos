import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { Asset } from '../entities/asset.entity';
import { ASSET_PROCESSING_QUEUE, ProcessAssetJobData } from '../queue/queue.constants';

/**
 * The BullMQ consumer. Registered as an ordinary provider in AppModule — it
 * runs inside the same process that serves HTTP, not a separate worker
 * container and not a second application bootstrap.
 */
@Processor(ASSET_PROCESSING_QUEUE)
export class AssetProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(AssetProcessingProcessor.name);
  private readonly mlServiceUrl: string;

  constructor(
    @InjectRepository(Asset)
    private readonly assets: Repository<Asset>,
    config: ConfigService,
  ) {
    super();
    this.mlServiceUrl = config
      .get<string>('ML_SERVICE_URL', 'http://ml-service:8000')
      .replace(/\/+$/, '');
  }

  async process(job: Job<ProcessAssetJobData>): Promise<void> {
    const { assetId, storageKey } = job.data;
    this.logger.log(`Processing asset ${assetId} (${storageKey})`);

    const asset = await this.assets.findOne({ where: { id: assetId } });
    if (!asset) {
      this.logger.warn(`Asset ${assetId} no longer exists, dropping job`);
      return;
    }

    await this.assets.update(assetId, { status: 'processing' });

    // A genuine HTTP call across the internal Docker network to the FastAPI
    // service — the point of this pass is proving that hop actually works,
    // even though the response itself is canned for now.
    const response = await fetch(`${this.mlServiceUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage_key: storageKey }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `ml-service returned ${response.status} ${response.statusText}`,
      );
    }

    const body = await response.json();
    this.logger.log(`ml-service response for ${assetId}: ${JSON.stringify(body)}`);

    await this.assets.update(assetId, { status: 'done' });
    this.logger.log(`Asset ${assetId} marked done`);
  }
}
