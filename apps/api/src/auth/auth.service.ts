import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../common/redis.module';
import { User, UserStatus } from '../entities/user.entity';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

/** refresh 토큰은 원문을 저장하지 않는다. Redis에는 SHA-256 해시만 둔다. */
const refreshKey = (jti: string) => `auth:refresh:${jti}`;

/**
 * 세션(access/refresh) 발급·회전. 공개 사용자 로그인은 소셜 전용이며(CLAW-37),
 * 계정 확정은 SocialAuthService가 담당한다. 이 서비스는 확정된 userId로 세션만 관리한다.
 */
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

  /** refresh 토큰 회전: 사용한 토큰은 즉시 폐기하고 새 쌍을 발급한다. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const { userId } = await this.consumeRefreshToken(refreshToken);

    const user = await this.dataSource.getRepository(User).findOneBy({ id: userId });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
    }
    return this.issueSession(userId);
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

    // GET과 DEL을 분리하면 동시 요청 둘 다 같은 토큰을 읽을 수 있다. GETDEL로
    // 최초 요청만 값을 가져가게 하고, secret 불일치도 기존 정책대로 jti를 폐기한다(CLAW-41).
    const stored = await this.redis.getdel(refreshKey(jti));
    if (!stored) throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });

    const [storedHash, userId] = stored.split(':');
    const actualHash = createHash('sha256').update(secret).digest('hex');
    if (storedHash !== actualHash) {
      // 해시 불일치 = 위조 시도. GETDEL 시점에 해당 jti는 이미 폐기됐다.
      throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });
    }

    return { userId };
  }

  /**
   * 확정된 userId로 access/refresh 세션을 발급한다.
   * 호출 측(SocialAuthService)이 계정·동의를 확정한 뒤에만 부른다 — 여기서 신뢰 경계를 다시 두지 않는다.
   */
  async issueSession(userId: string): Promise<TokenPair> {
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
