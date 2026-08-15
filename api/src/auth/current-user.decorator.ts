import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../entities/user.entity';

/**
 * Pulls the authenticated user off the request so controllers never reach into
 * request.user themselves. Only meaningful on routes behind JwtAuthGuard.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    return ctx.switchToHttp().getRequest().user;
  },
);
