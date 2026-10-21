import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { AttemptLimiter, AttemptLimitError } from '../auth/attempt-limiter.js';
import {
  ArgonCapacityError,
  PasswordPolicyError,
} from '../auth/password.service.js';
import type { ActorRequest } from '../auth/request-auth.js';
import { safeErrorCode } from '../errors/safe-error-code.js';
import {
  exactUserId,
  OperatorAccountError,
} from './operator-accounts.service.js';
import { UsernameConflictError } from './users.repository.js';
import { AdminAccountError, UsersService } from './users.service.js';
import { UsernameError } from './username.js';

function stringBody(
  body: unknown,
  fields: readonly string[],
): Record<string, string> {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== fields.length ||
    !fields.every(
      (field) => typeof (body as Record<string, unknown>)[field] === 'string',
    ) ||
    Object.keys(body).some((field) => !fields.includes(field))
  )
    throw new BadRequestException('Invalid request');
  return body as Record<string, string>;
}

function pagination(query: unknown): { limit: number; offset: number } {
  if (!query || typeof query !== 'object' || Array.isArray(query))
    throw new BadRequestException('Invalid request');
  const values = query as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== 'limit' && key !== 'offset'))
    throw new BadRequestException('Invalid request');
  const parse = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new BadRequestException('Invalid request');
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw new BadRequestException('Invalid request');
    return number;
  };
  const limit = parse(values.limit, 50);
  const offset = parse(values.offset, 0);
  if (limit < 1 || limit > 100)
    throw new BadRequestException('Invalid request');
  return { limit, offset };
}

function adminActor(request: ActorRequest) {
  const actor = request.authActor;
  if (!actor) throw new UnauthorizedException('Unauthorized');
  if (actor.role !== 'admin' || actor.passwordChangeRequired)
    throw new ForbiddenException('Forbidden');
  return actor;
}

function safeFailure(error: unknown, reply: FastifyReply): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof AdminAccountError) {
    if (error.reason === 'not_found') throw new HttpException('Not found', 404);
    if (error.reason === 'cannot_disable')
      throw new ConflictException('Account cannot be disabled');
    throw new UnauthorizedException('Unauthorized');
  }
  if (error instanceof UsernameConflictError)
    throw new ConflictException('Username already exists');
  if (error instanceof PasswordPolicyError)
    throw new BadRequestException('Invalid password');
  if (error instanceof UsernameError || error instanceof OperatorAccountError)
    throw new BadRequestException('Invalid request');
  if (
    error instanceof AttemptLimitError ||
    error instanceof ArgonCapacityError
  ) {
    reply.header('Retry-After', '900');
    throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
  }
  new Logger(UsersController.name).error(
    `Account operation failed; ${safeErrorCode(error)}`,
  );
  throw new ServiceUnavailableException('Database unavailable');
}

@Controller('api/v1/users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly attempts: AttemptLimiter,
  ) {}

  @Post()
  async create(
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-store');
    const actor = adminActor(request);
    const body = stringBody(request.body, [
      'username',
      'initialPassword',
      'currentPassword',
    ]);
    try {
      this.attempts.take(request.ip, actor.userId, 'reauth');
      return await this.users.create(
        actor,
        body.username,
        body.initialPassword,
        body.currentPassword,
      );
    } catch (error) {
      safeFailure(error, reply);
    }
  }

  @Get()
  async list(
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-store');
    adminActor(request);
    const { limit, offset } = pagination(request.query);
    try {
      return await this.users.list(limit, offset);
    } catch (error) {
      safeFailure(error, reply);
    }
  }

  @Post(':id/disable')
  @HttpCode(204)
  async disable(
    @Param('id') id: string,
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'no-store');
    const actor = adminActor(request);
    const body = stringBody(request.body, ['currentPassword']);
    try {
      const targetId = exactUserId(id);
      this.attempts.take(request.ip, actor.userId, 'reauth');
      await this.users.disable(actor, targetId, body.currentPassword);
    } catch (error) {
      safeFailure(error, reply);
    }
  }
}
