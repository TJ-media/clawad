import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import Redis from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';
import { REDIS_CLIENT } from '../common/redis.module';
import { loadPolicy } from '../common/policy';
import { DecisionPolicySnapshot } from '../entities/decision-policy-snapshot.entity';

export interface PolicySnapshot {
  policyVersion: number;
  rewardPolicyId: string | null;
  billingEligible: boolean;
  rewardEligible: boolean;
  pricePerImpressionKrw: number;
  rewardPerThousandAcceptedImpressions: number;
  minViewMs: number;
  concurrentToleranceMs: number;
  timeWindowToleranceMs: number;
  maxContinuousSessionMs: number;
  continuousSessionMaxGapMs: number;
  dailyAcceptedImpressionLimit: number;
  dailyRewardLimit: number;
  perCampaignDailyImpressionLimit: number;
  advertiserDailyImpressionLimit: number | null;
}

export interface ServeTokenClaims {
  campaignId: string;
  creativeId: string;
  userId: string;
  machineId: string;
  campaignType: string;
  policySnapshot: PolicySnapshot;
}

export interface ServeTokenPayload extends ServeTokenClaims {
  policySnapshotId: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

interface ServeTokenLib {
  issueServeToken(claims: ServeTokenClaims & { policySnapshotId: string }, secret: string, ttlMs: number, now?: number): string;
  verifyServeToken(
    token: string,
    secret: string,
    now?: number,
  ): { ok: true; payload: ServeTokenPayload } | { ok: false; reason: string };
}

interface IdempotencyLib {
  idempotencyKey(tokenJti: string, machineId: string, sequence: number): string;
}

const require_ = createRequire(__filename);
// apps/api/{src|dist}/campaigns → 저장소 루트
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** 서명·검증·멱등 로직을 중복하지 않고 참조 구현을 그대로 재사용한다 (CLAW-18 §참조 구현). */
const serveTokenLib: ServeTokenLib = require_(join(REPO_ROOT, 'server', 'lib', 'serveToken.js'));
const idempotencyLib: IdempotencyLib = require_(join(REPO_ROOT, 'server', 'lib', 'idempotency.js'));

export type VerifyResult =
  | { ok: true; payload: ServeTokenPayload }
  // EXPIRED는 서명 검증을 통과한 뒤의 실패라 payload를 함께 준다. 서명이 깨진 BAD_TOKEN에는 없다.
  | { ok: false; reason: string; payload?: ServeTokenPayload };

/**
 * serveToken 발급과 발급 registry (CLAW-18).
 *
 * - 서버만 비밀 키를 가진다. 클라이언트는 토큰을 보관·제출만 한다.
 * - 토큰을 발급받은 인증 사용자와 머신을 함께 서명해 다른 계정으로의 제출을 막는다.
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
    @InjectDataSource() private readonly dataSource: DataSource,
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

  async issue(
    claims: ServeTokenClaims,
    now = Date.now(),
    manager?: EntityManager,
  ): Promise<{ serveToken: string; expiresAt: number }> {
    const policy = loadPolicy().serveToken;
    const count = await this.unusedCount(claims.machineId, now);
    if (count >= policy.maxUnusedTokensPerMachine) {
      throw new HttpException(
        { error: 'PREFETCH_LIMIT_EXCEEDED', limit: policy.maxUnusedTokensPerMachine, unused: count },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const contentHash = createHash('sha256').update(JSON.stringify(claims.policySnapshot)).digest('hex');
    const db = manager ?? this.dataSource.manager;
    const repo = db.getRepository(DecisionPolicySnapshot);
    let stored = await repo.findOneBy({ contentHash });
    if (!stored) {
      // shared outer transaction 안에서 unique 경합이 나도 transaction-aborted 상태가 되지 않게
      // ON CONFLICT DO NOTHING으로 수렴한 뒤 canonical 행을 다시 읽는다.
      await db.query(
        `INSERT INTO decision_policy_snapshots ("contentHash", "policyVersion", snapshot)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT ("contentHash") DO NOTHING`,
        [contentHash, claims.policySnapshot.policyVersion, JSON.stringify(claims.policySnapshot)],
      );
      stored = await repo.findOneByOrFail({ contentHash });
    }
    const serveToken = serveTokenLib.issueServeToken(
      { ...claims, policySnapshotId: stored.id },
      this.secret(),
      policy.ttlMs,
      now,
    );
    const verified = serveTokenLib.verifyServeToken(serveToken, this.secret(), now);
    if (!verified.ok) throw new ServiceUnavailableException({ error: 'TOKEN_ISSUE_FAILED' });

    const { jti, expiresAt } = verified.payload;
    // registry는 토큰 수명보다 오래 남겨야 한다 (CLAW-102). sync는 주기 실행이라 표시와 업로드 사이가
    // 벌어지는데, registry가 토큰과 동시에 사라지면 표시 당시 유효했던 노출이 TOKEN_REVOKED로 거절된다.
    // 업로드 지연 상한만큼 더 보관해, 그 창 안에 도착한 제출은 발급 사실을 대조할 수 있게 한다.
    const uploadGraceMs = loadPolicy().impression.maxUploadDelayMs || 0;
    const ttlSeconds = Math.ceil((policy.ttlMs + uploadGraceMs) / 1000);
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

  /** 서명·만료 검증 (CLAW-6이 소비). 서버만 비밀 키를 가진다. */
  verify(token: string, now = Date.now()): VerifyResult {
    return serveTokenLib.verifyServeToken(token, this.secret(), now);
  }

  async snapshotMatches(payload: ServeTokenPayload, manager?: EntityManager): Promise<boolean> {
    const contentHash = createHash('sha256').update(JSON.stringify(payload.policySnapshot)).digest('hex');
    return Boolean(
      await (manager ?? this.dataSource.manager).getRepository(DecisionPolicySnapshot).findOneBy({
        id: payload.policySnapshotId,
        contentHash,
        policyVersion: payload.policySnapshot.policyVersion,
      }),
    );
  }

  /** 서버 생성 멱등 키. 클라이언트는 이 값을 만들지 못한다. */
  idempotencyKey(tokenJti: string, machineId: string, sequence: number): string {
    return idempotencyLib.idempotencyKey(tokenJti, machineId, sequence);
  }

  /**
   * 발급 registry 대조: 제출된 토큰의 SHA-256이 발급 시 저장한 값과 일치하는지 본다.
   * 반환값으로 registry에 살아있는지도 알린다(만료·폐기·소비 후 정리되면 없음).
   */
  async registryMatches(jti: string, token: string): Promise<{ known: boolean; matches: boolean }> {
    const stored = await this.redis.get(this.registryKey(jti));
    if (!stored) return { known: false, matches: false };
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return { known: true, matches: stored === tokenHash };
  }

  /**
   * 토큰 소비: registry에서 지우고 미사용 집합에서 뺀다 (CONSUMED 전이).
   * 소비된 토큰은 다시 발급 여유로 잡히지 않고, registry 대조에서 known=false가 된다.
   * 멱등 — 이미 소비된 토큰을 다시 소비해도 안전하다.
   */
  async consume(jti: string, machineId: string): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.del(this.registryKey(jti));
    pipeline.zrem(this.unusedKey(machineId), jti);
    await pipeline.exec();
  }
}
