import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.module';
import { loadPolicy } from '../common/policy';

/** 서빙 로테이션 키 보관 기간. 노출 판정이 아니라 후보 순서를 흔들기 위한 값이다. */
const SERVE_ROTATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 노출 빈도 상한 (CLAW-23 §노출 상한 반영).
 * 상한값은 정책 설정에서 읽는다 — 코드에 숫자를 하드코딩하지 않는다 (CLAW-12).
 *
 * 여기서의 판정은 **광고 결정 단계의 조언적 필터**다. 확정 판정(과금·리워드 인정)은
 * CLAW-6의 이벤트 원장 기준으로 서버가 다시 수행한다. 상한은 기기별이 아니라
 * **계정 단위**로 적용한다 (rules §4b).
 */
@Injectable()
export class FrequencyService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private get policy() {
    return loadPolicy();
  }

  private dayKey(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  private campaignDailyKey(userId: string, campaignId: string, now: Date): string {
    return `freq:campaign:${userId}:${campaignId}:${this.dayKey(now)}`;
  }

  private advertiserDailyKey(userId: string, advertiserId: string, now: Date): string {
    return `freq:advertiser:${userId}:${advertiserId}:${this.dayKey(now)}`;
  }

  private creativeLastSeenKey(userId: string, creativeId: string): string {
    return `freq:creative:${userId}:${creativeId}`;
  }

  private dailyAcceptedKey(userId: string, now: Date): string {
    return `freq:accepted:${userId}:${this.dayKey(now)}`;
  }

  /**
   * 캠페인을 이 사용자에게 마지막으로 **서빙**한 시각 (CLAW-102).
   * creativeLastSeen은 인정 노출에만 갱신되므로, 프리페치가 연속으로 여러 건을 받아갈 때
   * 후보 순서를 흔들지 못한다. 서빙 시점에 갱신하는 별도 키로 라운드로빈을 만든다.
   */
  private campaignLastServedKey(userId: string, campaignId: string): string {
    return `serve:campaign:${userId}:${campaignId}`;
  }

  /** 후보 캠페인들의 마지막 서빙 시각. 기록이 없으면 map에서 빠진다(= 가장 오래된 것으로 취급). */
  async lastServedAt(userId: string, campaignIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!campaignIds.length) return result;
    const values = await this.redis.mget(...campaignIds.map((id) => this.campaignLastServedKey(userId, id)));
    campaignIds.forEach((id, index) => {
      const value = Number(values[index]);
      if (Number.isFinite(value) && value > 0) result.set(id, value);
    });
    return result;
  }

  /** 서빙 사실을 기록한다. 노출 인정과 무관하며 과금·리워드 판정에 쓰지 않는다. */
  async recordServe(userId: string, campaignId: string, now = new Date()): Promise<void> {
    await this.redis.set(
      this.campaignLastServedKey(userId, campaignId),
      String(now.getTime()),
      'PX',
      SERVE_ROTATION_TTL_MS,
    );
  }

  /** 계정 단위 일일 유효 노출 상한(정책값)에 도달했는가. */
  async isDailyAcceptedCapReached(userId: string, now = new Date()): Promise<boolean> {
    const count = Number((await this.redis.get(this.dailyAcceptedKey(userId, now))) ?? 0);
    return count >= this.policy.reward.dailyAcceptedImpressionLimit;
  }

  /** 캠페인별 일일 노출 상한(계정 단위)에 도달했는가. */
  async isCampaignCapReached(userId: string, campaignId: string, now = new Date()): Promise<boolean> {
    const count = Number((await this.redis.get(this.campaignDailyKey(userId, campaignId, now))) ?? 0);
    return count >= this.policy.frequency.perCampaignDailyImpressionLimit;
  }

  /** 같은 크리에이티브를 최소 간격 이내에 다시 보여주려 하는가. */
  async isCreativeTooSoon(userId: string, creativeId: string, now = new Date()): Promise<boolean> {
    const lastSeen = await this.redis.get(this.creativeLastSeenKey(userId, creativeId));
    if (!lastSeen) return false;
    return now.getTime() - Number(lastSeen) < this.policy.frequency.sameCreativeMinIntervalMs;
  }

  /** 광고주 단위 일일 상한. limit이 null이면 무제한. */
  async isAdvertiserCapReached(
    userId: string,
    advertiserId: string,
    limit: number | null,
    now = new Date(),
  ): Promise<boolean> {
    if (limit === null) return false;
    const count = Number((await this.redis.get(this.advertiserDailyKey(userId, advertiserId, now))) ?? 0);
    return count >= limit;
  }

  /**
   * 인정된 노출을 빈도 카운터에 반영한다. CLAW-6이 이벤트를 ACCEPTED로 판정한 뒤 호출한다.
   * 광고를 서빙한 시점이 아니라 **인정된 시점**에 센다 — 프리페치가 상한을 갉아먹지 않게 한다.
   */
  async recordAcceptedImpression(
    userId: string,
    advertiserId: string,
    campaignId: string,
    creativeId: string,
    now = new Date(),
  ): Promise<void> {
    const ttlSeconds = 2 * 24 * 60 * 60; // 일자 경계 여유
    const pipeline = this.redis.multi();
    pipeline.incr(this.campaignDailyKey(userId, campaignId, now));
    pipeline.expire(this.campaignDailyKey(userId, campaignId, now), ttlSeconds);
    pipeline.incr(this.advertiserDailyKey(userId, advertiserId, now));
    pipeline.expire(this.advertiserDailyKey(userId, advertiserId, now), ttlSeconds);
    pipeline.incr(this.dailyAcceptedKey(userId, now));
    pipeline.expire(this.dailyAcceptedKey(userId, now), ttlSeconds);
    pipeline.set(
      this.creativeLastSeenKey(userId, creativeId),
      String(now.getTime()),
      'PX',
      this.policy.frequency.sameCreativeMinIntervalMs,
    );
    await pipeline.exec();
  }
}
