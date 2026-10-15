import { Injectable } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
  service: 'saefr-photos';
}

@Injectable()
export class HealthService {
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'saefr-photos',
    };
  }
}
