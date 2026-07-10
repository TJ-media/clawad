import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.module';
import { loadPolicy } from '../common/policy';

export interface ServeTokenClaims {
  campaignId: string;
  creativeId: string;
  machineId: string;
  campaignType: string;
}

export interface ServeTokenPayload extends ServeTokenClaims {
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

interface ServeTokenLib {
  issueServeToken(claims: ServeTokenClaims, secret: string, ttlMs: number, now?: number): string;
  verifyServeToken(
    token: string,
    secret: string,
    now?: number,
  ): { ok: true; payload: ServeTokenPayload } | { ok: false; reason: string };
}

const require_ = createRequire(__filename);
// apps/api/{src|dist}/campaigns → 저장소 루트
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** 서명·검증 로직을 중복하지 않고 참조 구현을 그대로 재사용한다 (CLAW-18 §참조 구현). */
const serveTokenLib: ServeTokenLib = require_(join(REPO_ROOT, 'server', 'lib', 'serveToken.js'));

/**
 * serveToken 발급과 발급 registry (CLAW-18).
 *
 * - 서버만 비밀 키를 가진다. 클라이언트는 토큰을 보관·제출만 한다.
 * - 머신당 미사용 토큰 수를 정책값으로 제한한다.
 * - registry에 jti와 토큰 SHA-256을 보관한다. CLAW-6이 제출된 토큰을 registry와 대조하고
 *   CONSUMED로 전이시킨다. 이 서비스는 발급과 폐기까지만 책임진다.
 *
 * **토큰 발급·만료는 예산 예약/해제를 만들지 않는다** (CLAW-23, ledgers.md §예산).
 */
@Injectable()
export class ServeTokenService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const secret = this.config.get<string>('SERVE_TOKEN_SECRET');
    // 공개 fallback을 두지 않는다 (CLAW-18 §서명 키). 32바이트 이상 서버 전용 비밀값.
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new ServiceUnavailableException({ error: 'SERVE_TOKEN_SECRET_NOT_CONFIGURED' });
    }
    return secret;
  }

  /** 머신별 미사용 토큰 집합. score = expiresAt (만료분 정리에 사용). */
  private unusedKey(machineId: string): string {
    return `servetoken:unused:${machineId}`;
  }

  /** jti → 발급된 토큰의 SHA-256. CLAW-6이 제출값과 대조한다. */
  private registryKey(jti: string): string {
    return `servetoken:jti:${jti}`;
  }

  private async pruneExpired(machineId: string, now: number): Promise<void> {
    await this.redis.zremrangebyscore(this.unusedKey(machineId), '-inf', now);
  }

  async unusedCount(machineId: string, now = Date.now()): Promise<number> {
    await this.pruneExpired(machineId, now);
    return this.redis.zcard(this.unusedKey(machineId));
  }

  /** 리필이 필요한가. 남은 유효 토큰이 임계 이하일 때만 추가 발급한다. */
  async needsRefill(machineId: string, now = Date.now()): Promise<boolean> {
    const policy = loadPolicy().serveToken;
    return (await this.unusedCount(machineId, now)) <= policy.prefetchRefillThreshold;
  }

  async issue(claims: ServeTokenClaims, now = Date.now()): Promise<{ serveToken: string; expiresAt: number }> {
    const policy = loadPolicy().serveToken;
    const count = await this.unusedCount(claims.machineId, now);
    if (count >= policy.maxUnusedTokensPerMachine) {
      throw new HttpException(
        { error: 'PREFETCH_LIMIT_EXCEEDED', limit: policy.maxUnusedTokensPerMachine, unused: count },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const serveToken = serveTokenLib.issueServeToken(claims, this.secret(), policy.ttlMs, now);
    const verified = serveTokenLib.verifyServeToken(serveToken, this.secret(), now);
    if (!verified.ok) throw new ServiceUnavailableException({ error: 'TOKEN_ISSUE_FAILED' });

    const { jti, expiresAt } = verified.payload;
    const ttlSeconds = Math.ceil(policy.ttlMs / 1000);
    const tokenHash = createHash('sha256').update(serveToken).digest('hex');

    const pipeline = this.redis.multi();
    pipeline.zadd(this.unusedKey(claims.machineId), expiresAt, jti);
    pipeline.pexpire(this.unusedKey(claims.machineId), policy.ttlMs * 2);
    // 토큰 원문은 저장하지 않는다. 해시만 둔다 (privacy-design.md §6.5).
    pipeline.set(this.registryKey(jti), tokenHash, 'EX', ttlSeconds);
    await pipeline.exec();

    return { serveToken, expiresAt };
  }

  /**
   * 로컬 캐시 유실 복구: 해당 머신의 미사용 토큰을 멱등 폐기한다.
   * 폐기된 토큰은 재사용할 수 없다. 예산 예약이 없으므로 해제할 것도 없다.
   */
  async revokeUnused(machineId: string): Promise<number> {
    const jtis = await this.redis.zrange(this.unusedKey(machineId), 0, -1);
    const pipeline = this.redis.multi();
    for (const jti of jtis) pipeline.del(this.registryKey(jti));
    pipeline.del(this.unusedKey(machineId));
    await pipeline.exec();
    return jtis.length;
  }
}
