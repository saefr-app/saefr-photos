import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';

/** Shared by bootstrap and production-composition HTTP tests. */
export function createHttpAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    multipart: true,
    bodyLimit: 8192,
    routerOptions: { ignoreTrailingSlash: true },
    // Bad URL decoding happens before onRequest and Nest exception filters.
    // Never echo the raw path or Fastify's error object back to a caller.
    frameworkErrors(
      error: FastifyError,
      _request: FastifyRequest,
      reply: FastifyReply,
    ) {
      const status = error.code === 'FST_ERR_BAD_URL' ? 400 : 500;
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply
        .type('application/json')
        .code(status)
        .send({
          statusCode: status,
          message: status === 400 ? 'Bad Request' : 'Internal server error',
          error: status === 400 ? 'Bad Request' : 'Internal Server Error',
        });
    },
  });
}
