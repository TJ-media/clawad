import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../common/redis.module';
import { hashPassword, verifyPassword } from '../common/password';
import { Consent, REQUIRED_CONSENTS } from '../entities/consent.entity';
import { Identity, IdentityProvider } from '../entities/identity.entity';
import { User, UserStatus } from '../entities/user.entity';
import { ConsentInput, LoginDto, SignupDto } from './dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

/** refresh 토큰은 원문을 저장하지 않는다. Redis에는 SHA-256 해시만 둔다. */
const refreshKey = (jti: string) => `auth:refresh:${jti}`;

@Injectable()
export class AuthService {
  private readonly refreshTtlSeconds: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    const days = Number(config.get<string>('REFRESH_TOKEN_TTL_DAYS', '30'));
    this.refreshTtlSeconds = days * 24 * 60 * 60;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private assertRequiredConsents(consents: ConsentInput[]): void {
    const granted = new Set(consents.filter((c) => c.granted).map((c) => c.type));
    const missing = REQUIRED_CONSENTS.filter((t) => !granted.has(t));
    if (missing.length) {
      throw new BadRequestException({
        error: 'REQUIRED_CONSENT_MISSING',
        missing,
      });
    }
  }

  async signup(dto: SignupDto): Promise<TokenPair> {
    this.assertRequiredConsents(dto.consents);
    const email = this.normalizeEmail(dto.email);
    const passwordHash = await hashPassword(dto.password);

    const userId = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(Identity, {
        where: { provider: IdentityProvider.EMAIL, providerSubject: email },
      });
      // 계정 존재 여부를 응답으로 구분하지 않도록 동일한 형태의 409를 반환한다.
      if (existing) throw new BadRequestException({ error: 'SIGNUP_FAILED' });

      const user = await manager.save(manager.create(User, { email, status: UserStatus.ACTIVE }));
      await manager.save(
        manager.create(Identity, {
          userId: user.id,
          provider: IdentityProvider.EMAIL,
          providerSubject: email,
          passwordHash,
        }),
      );
      // 동의는 항목별 독립 행으로 저장한다. 선택 동의의 거부(granted=false)도 이력으로 남긴다.
      await manager.save(
        dto.consents.map((c) =>
          manager.create(Consent, {
            userId: user.id,
            type: c.type,
            granted: c.granted,
            documentVersion: c.documentVersion,
          }),
        ),
      );
      return user.id;
    });

    return this.issueTokens(userId);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const email = this.normalizeEmail(dto.email);
    const identity = await this.dataSource.getRepository(Identity).findOne({
      where: { provider: IdentityProvider.EMAIL, providerSubject: email },
      relations: { user: true },
    });

    // 사용자 존재 여부를 타이밍·응답으로 노출하지 않는다. 없으면 더미 검증 후 동일한 401.
    const ok = await verifyPassword(dto.password, identity?.passwordHash ?? null);
    if (!identity || !ok) throw new UnauthorizedException({ error: 'INVALID_CREDENTIALS' });
    if (identity.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
    }

    return this.issueTokens(identity.userId);
  }

  /** refresh 토큰 회전: 사용한 토큰은 즉시 폐기하고 새 쌍을 발급한다. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const { userId } = await this.consumeRefreshToken(refreshToken);

    const user = await this.dataSource.getRepository(User).findOneBy({ id: userId });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
    }
    return this.issueTokens(userId);
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      await this.consumeRefreshToken(refreshToken);
    } catch {
      // 이미 폐기된 토큰의 로그아웃은 성공으로 취급한다(멱등).
    }
  }

  private async consumeRefreshToken(refreshToken: string): Promise<{ userId: string }> {
    const [jti, secret] = refreshToken.split('.');
    if (!jti || !secret) throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });

    const stored = await this.redis.get(refreshKey(jti));
    if (!stored) throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });

    const [storedHash, userId] = stored.split(':');
    const actualHash = createHash('sha256').update(secret).digest('hex');
    if (storedHash !== actualHash) {
      // 해시 불일치 = 위조 시도. 해당 jti를 폐기한다.
      await this.redis.del(refreshKey(jti));
      throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });
    }

    await this.redis.del(refreshKey(jti));
    return { userId };
  }

  private async issueTokens(userId: string): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId });

    const jti = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(secret).digest('hex');
    await this.redis.set(refreshKey(jti), `${hash}:${userId}`, 'EX', this.refreshTtlSeconds);

    return {
      accessToken,
      refreshToken: `${jti}.${secret}`,
      expiresIn: process.env.ACCESS_TOKEN_TTL ?? '15m',
    };
  }
}
