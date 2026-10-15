import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';

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
  constructor(
    private readonly databaseService: DatabaseService,
  ) {}

  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'saefr-photos',
    };
  }

  async getReadiness(): Promise<ReadinessResponse> {
    try {
      await this.databaseService.ping();
    } catch {
      throw new ServiceUnavailableException(
        'Database unavailable',
      );
    }

    return {
      status: 'ok',
      database: 'connected',
    };
  }
}
