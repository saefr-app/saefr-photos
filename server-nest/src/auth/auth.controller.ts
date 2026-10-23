import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  exactUserId,
  OperatorAccountError,
} from '../users/operator-accounts.service.js';
import { canonicalUsername } from '../users/username.js';
import { safeErrorCode } from '../errors/safe-error-code.js';
import { AttemptLimiter, AttemptLimitError } from './attempt-limiter.js';
import {
  AuthenticationFailure,
  AuthSessionService,
  type AuthenticatedActor,
} from './auth-session.service.js';
import { ArgonCapacityError, PasswordPolicyError } from './password.service.js';
import {
  type ActorRequest,
  clearSessionCookie,
  exactOrigin,
  PublicRoute,
  sessionCookie,
} from './request-auth.js';

function bodyFields(
  body: unknown,
  expected: readonly string[],
): Record<string, string> {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== expected.length ||
    !expected.every(
      (name) => typeof (body as Record<string, unknown>)[name] === 'string',
    ) ||
    Object.keys(body).some((name) => !expected.includes(name))
  )
    throw new BadRequestException('Invalid request');
  return body as Record<string, string>;
}

function actorOf(request: ActorRequest): AuthenticatedActor {
  if (!request.authActor) throw new UnauthorizedException('Unauthorized');
  return request.authActor;
}

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}

function safeFailure(error: unknown, reply: FastifyReply): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof AuthenticationFailure) {
    if (error.reason === 'session_limit')
      throw new ConflictException('Session limit reached');
    if (error.reason === 'not_found') throw new HttpException('Not found', 404);
    throw new UnauthorizedException('Unauthorized');
  }
  if (error instanceof PasswordPolicyError)
    throw new BadRequestException('Invalid password');
  if (error instanceof OperatorAccountError)
    throw new BadRequestException('Invalid request');
  if (
    error instanceof AttemptLimitError ||
    error instanceof ArgonCapacityError
  ) {
    reply.header('Retry-After', '900');
    throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
  }
  new Logger(AuthController.name).error(
    `Authentication operation failed; ${safeErrorCode(error)}`,
  );
  throw new ServiceUnavailableException('Database unavailable');
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly sessions: AuthSessionService,
    private readonly config: ConfigService,
    private readonly attempts: AttemptLimiter,
  ) {}

  @Post('login')
  @PublicRoute()
  @HttpCode(200)
  async login(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    exactOrigin(request, this.config);
    if (
      request.headers['x-saefr-login'] !== '1' ||
      request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !==
        'application/json' ||
      request.headers.authorization !== undefined ||
      request.headers.cookie !== undefined
    )
      throw new BadRequestException('Invalid request');
    const body = bodyFields(request.body, ['username', 'password']);
    let username: string;
    try {
      username = canonicalUsername(body.username);
    } catch {
      username = '__invalid_username__';
    }
    try {
      this.attempts.take(request.ip, username, 'login');
      const { actor, credential } = await this.sessions.login(
        username,
        body.password,
      );
      reply.header(
        'Set-Cookie',
        sessionCookie(this.config, credential, actor.expiresAt),
      );
      return {
        user: {
          id: actor.userId,
          username: actor.username,
          role: actor.role,
          passwordChangeRequired: actor.passwordChangeRequired,
        },
        session: {
          id: actor.sessionId,
          expiresAt: actor.expiresAt.toISOString(),
        },
        csrfToken: actor.csrfToken.toString('base64url'),
      };
    } catch (error) {
      safeFailure(error, reply);
    }
  }

  @Post('password')
  @HttpCode(204)
  async password(
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const actor = actorOf(request);
    const body = bodyFields(request.body, ['currentPassword', 'newPassword']);
    try {
      this.attempts.take(request.ip, actor.userId, 'reauth');
      await this.sessions.changePassword(
        actor,
        body.currentPassword,
        body.newPassword,
      );
      reply.header('Set-Cookie', clearSessionCookie(this.config));
    } catch (error) {
      safeFailure(error, reply);
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    try {
      await this.sessions.logout(actorOf(request));
      reply.header('Set-Cookie', clearSessionCookie(this.config));
    } catch (error) {
      safeFailure(error, reply);
    }
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    try {
      await this.sessions.logoutAll(actorOf(request));
      reply.header('Set-Cookie', clearSessionCookie(this.config));
    } catch (error) {
      safeFailure(error, reply);
    }
  }

  @Get('sessions')
  async listSessions(
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    try {
      return await this.sessions.listSessions(actorOf(request));
    } catch (error) {
      safeFailure(error, reply);
    }
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(
    @Param('id') id: string,
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    try {
      const target = exactUserId(id);
      const actor = actorOf(request);
      if (!(await this.sessions.revoke(actor, target)))
        throw new AuthenticationFailure('not_found');
      if (target === actor.sessionId)
        reply.header('Set-Cookie', clearSessionCookie(this.config));
    } catch (error) {
      safeFailure(error, reply);
    }
  }
}

@Controller('api/v1')
export class MeController {
  @Get('me')
  me(
    @Req() request: ActorRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const actor = actorOf(request);
    return {
      id: actor.userId,
      username: actor.username,
      role: actor.role,
      passwordChangeRequired: actor.passwordChangeRequired,
      session: {
        id: actor.sessionId,
        expiresAt: actor.expiresAt.toISOString(),
      },
      csrfToken: actor.csrfToken.toString('base64url'),
      assetsAvailable: !actor.passwordChangeRequired,
    };
  }
}
