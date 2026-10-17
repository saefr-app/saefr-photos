import {
  Catch,
  HttpException,
  Injectable,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { safeErrorCode } from './safe-error-code.js';

const PUBLIC_MESSAGES: Readonly<Record<number, readonly string[]>> = {
  400: [
    'Image file is required',
    'Invalid filename',
    'Invalid multipart request',
    'Incomplete multipart request',
    'Unexpected multipart field',
    'Validation failed (uuid is expected)',
  ],
  404: ['Asset not found', 'Asset file not found'],
  413: ['File too large'],
  415: [
    'Unsupported image type',
    'Empty image file',
    'Invalid image data',
    'Invalid or unsupported image',
    'Unable to decode image',
  ],
  503: ['Database unavailable'],
};

const STATUS_LABELS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const ROUTES = new Set([
  '/health',
  '/health/ready',
  '/api/v1/assets',
  '/api/v1/assets/upload',
  '/api/v1/assets/:assetId',
  '/api/v1/assets/:assetId/original',
  '/api/v1/assets/:assetId/thumbnail',
]);

function publicMessage(exception: HttpException, status: number): string {
  const response = exception.getResponse();
  const candidate =
    typeof response === 'string'
      ? response
      : typeof response === 'object' &&
          response !== null &&
          'message' in response &&
          typeof response.message === 'string'
        ? response.message
        : undefined;

  return candidate && PUBLIC_MESSAGES[status]?.includes(candidate)
    ? candidate
    : (STATUS_LABELS[status] ?? 'Request failed');
}

@Injectable()
@Catch()
export class SafeHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeHttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const safeStatus = status >= 400 && status <= 599 ? status : 500;

    const readinessFailure =
      safeStatus === 503 &&
      exception instanceof HttpException &&
      publicMessage(exception, 503) === 'Database unavailable';

    if (safeStatus >= 500 && !readinessFailure) {
      const route = request.routeOptions?.url;
      const safeRoute = route && ROUTES.has(route) ? route : 'unknown route';
      const method =
        request.method === 'GET' || request.method === 'POST'
          ? request.method
          : 'OTHER';

      this.logger.error(
        `Request failure: ${method} ${safeRoute}; ${safeErrorCode(exception)}`,
      );
    }

    if (reply.sent || reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }

    // Fastify may have copied StreamableFile headers to the raw response
    // before a stream fails, even though no response bytes were sent.
    reply.removeHeader('content-type');
    reply.removeHeader('content-length');
    reply.removeHeader('content-disposition');
    reply.type('application/json');

    const error = STATUS_LABELS[safeStatus] ?? 'Request failed';
    const message =
      safeStatus === 500 || !(exception instanceof HttpException)
        ? 'Internal server error'
        : publicMessage(exception, safeStatus);

    reply.status(safeStatus).send({ statusCode: safeStatus, message, error });
  }
}
