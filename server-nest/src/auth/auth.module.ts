import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { DatabaseModule } from '../database/database.module.js';
import { AttemptLimiter } from './attempt-limiter.js';
import { AuthController, MeController } from './auth.controller.js';
import { AuthSessionService } from './auth-session.service.js';
import { PasswordService } from './password.service.js';
import { DefaultDenyGuard, RequestAuthenticator } from './request-auth.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController, MeController],
  providers: [
    PasswordService,
    AttemptLimiter,
    AuthSessionService,
    RequestAuthenticator,
    { provide: APP_GUARD, useClass: DefaultDenyGuard },
  ],
  exports: [AuthSessionService, RequestAuthenticator],
})
export class AuthModule {}
