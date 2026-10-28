import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { safeErrorCode } from '../errors/safe-error-code.js';

export interface HealthResponse {
  status: 'ok';
  service: 'saefr-photos';
}

export interface ReadinessResponse {
  status: 'ok';
  database: 'connected';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'saefr-photos',
    };
  }

  async getReadiness(): Promise<ReadinessResponse> {
    try {
      await this.databaseService.ping();
    } catch (error: unknown) {
      this.logger.warn(`Readiness check failed; ${safeErrorCode(error)}`);
      throw new ServiceUnavailableException('Database unavailable');
    }

    return {
      status: 'ok',
      database: 'connected',
    };
  }
}
