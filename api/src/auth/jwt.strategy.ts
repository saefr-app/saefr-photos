import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { JwtPayload } from './auth.service';

/**
 * Registered under the name 'jwt' — JwtAuthGuard extends AuthGuard('jwt').
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  /** Return value lands on request.user, read via the @CurrentUser() decorator. */
  async validate(payload: JwtPayload): Promise<User> {
    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user) {
      // Token is well-formed but the account is gone.
      throw new UnauthorizedException();
    }
    return user;
  }
}
