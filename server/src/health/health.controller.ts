import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  HealthService,
  type HealthResponse,
  type ReadinessResponse,
} from './health.service.js';
import { PublicRoute } from '../auth/request-auth.js';

@ApiTags('health')
@Controller('health')
@PublicRoute()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Application health check',
  })
  @ApiOkResponse({
    description: 'The API process is running.',
    schema: {
      type: 'object',
      required: ['status', 'service'],
      properties: {
        status: {
          type: 'string',
          example: 'ok',
        },
        service: {
          type: 'string',
          example: 'saefr-photos',
        },
      },
    },
  })
  getHealth(): HealthResponse {
    return this.healthService.getHealth();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Database readiness check',
  })
  @ApiOkResponse({
    description: 'PostgreSQL is available.',
    schema: {
      type: 'object',
      required: ['status', 'database'],
      properties: {
        status: {
          type: 'string',
          example: 'ok',
        },
        database: {
          type: 'string',
          example: 'connected',
        },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'PostgreSQL is unavailable.',
  })
  getReadiness(): Promise<ReadinessResponse> {
    return this.healthService.getReadiness();
  }
}
