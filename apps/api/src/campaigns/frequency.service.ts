import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.module';
import { loadPolicy } from '../common/policy';

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
    pipeline.set(
      this.creativeLastSeenKey(userId, creativeId),
      String(now.getTime()),
      'PX',
      this.policy.frequency.sameCreativeMinIntervalMs,
    );
    await pipeline.exec();
  }
}
