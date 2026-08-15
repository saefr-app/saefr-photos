import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';
import { Library } from '../entities/library.entity';
import { LibraryMembership } from '../entities/library-membership.entity';
import { User } from '../entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';

const BCRYPT_ROUNDS = 12;

export interface JwtPayload {
  sub: string;
  email: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Creates the user, their personal Library, and the owner membership joining
   * the two — all in one transaction. Every user must have somewhere to upload
   * to the moment they register, so library creation is part of signup rather
   * than a separate step.
   */
  async signup(dto: SignupDto): Promise<{ accessToken: string }> {
    const email = dto.email.toLowerCase().trim();

    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with that email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.dataSource.transaction(async (manager) => {
      const savedUser = await manager.save(
        manager.create(User, { email, passwordHash }),
      );

      const library = await manager.save(
        manager.create(Library, { name: `${email}'s Library` }),
      );

      await manager.save(
        manager.create(LibraryMembership, {
          userId: savedUser.id,
          libraryId: library.id,
          role: 'owner',
        }),
      );

      return savedUser;
    });

    return { accessToken: this.signToken(user) };
  }

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.users.findOne({ where: { email } });

    // Identical error for "no such user" and "wrong password" — the endpoint
    // must never reveal which accounts exist.
    const invalid = new UnauthorizedException('Invalid email or password');
    if (!user) {
      throw invalid;
    }

    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) {
      throw invalid;
    }

    return { accessToken: this.signToken(user) };
  }

  private signToken(user: User): string {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    // 24h with no refresh-token rotation and no revocation list. This is a
    // placeholder until refresh rotation exists — at that point this drops to a
    // short-lived access token.
    return this.jwt.sign(payload, { expiresIn: '24h' });
  }
}
