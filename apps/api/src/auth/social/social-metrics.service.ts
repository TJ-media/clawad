import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis.module';
import { IdentityProvider } from '../../entities/identity.entity';

const metricKey = (provider: IdentityProvider, date: string) => `auth:social:metrics:${provider}:${date}`;

export interface SocialProviderMetrics {
  provider: IdentityProvider;
  success: number;
  failures: number;
  canceled: number;
  failureRate: number;
  errorCodes: Record<string, number>;
}

/** 공급자 토큰·subject 없이 운영 성공률과 안전한 오류 코드만 Redis에 누적한다. */
@Injectable()
export class SocialMetricsService {
  private readonly logger = new Logger(SocialMetricsService.name);
  readonly retentionDays: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.retentionDays = Number(config.get<string>('SOCIAL_METRICS_RETENTION_DAYS', '30'));
    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 1 || this.retentionDays > 90) {
      throw new Error('SOCIAL_METRICS_RETENTION_DAYS는 1~90일 정수여야 합니다.');
    }
  }

  async record(provider: IdentityProvider, outcome: string): Promise<void> {
    try {
      const key = metricKey(provider, new Date().toISOString().slice(0, 10));
      await this.redis.multi().hincrby(key, outcome, 1).expire(key, this.retentionDays * 86_400).exec();
    } catch {
      this.logger.warn(`소셜 로그인 메트릭 기록 실패: provider=${provider}`);
    }
  }

  async snapshot(providers: readonly IdentityProvider[]): Promise<SocialProviderMetrics[]> {
    return Promise.all(providers.map(async (provider) => {
      const dates = Array.from({ length: this.retentionDays }, (_, offset) => {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - offset);
        return date.toISOString().slice(0, 10);
      });
      const rows = await Promise.all(dates.map((date) => this.redis.hgetall(metricKey(provider, date))));
      const raw = rows.reduce<Record<string, number>>((totals, row) => {
        for (const [code, count] of Object.entries(row)) totals[code] = (totals[code] ?? 0) + Number(count);
        return totals;
      }, {});
      const success = Number(raw.SUCCESS ?? 0);
      const canceled = Number(raw.CANCELED ?? 0);
      const errorCodes = Object.fromEntries(
        Object.entries(raw)
          .filter(([code]) => code !== 'SUCCESS' && code !== 'CANCELED')
          .map(([code, count]) => [code, count]),
      );
      const failures = Object.values(errorCodes).reduce((sum, count) => sum + count, 0);
      const decided = success + failures;
      return { provider, success, failures, canceled, failureRate: decided === 0 ? 0 : failures / decided, errorCodes };
    }));
  }
}
