import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { performance } from 'node:perf_hooks';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../common/redis.module';
import {
  HTTP_LATENCY_BUCKETS_MS,
  IMPRESSION_REASONS,
  ImpressionReason,
  OAuthOutcome,
  OAuthProvider,
  OAUTH_OUTCOMES,
  OAUTH_PROVIDERS,
  OAUTH_STAGES,
  OAuthStage,
  ObservedRewardEntryType,
  ObservedSwitchTarget,
  REWARD_ENTRY_TYPES,
  safeImpressionReason,
  safeOAuthOutcome,
  safeSwitchTarget,
  SWITCH_TARGETS,
  UPLOAD_DELAY_BUCKETS_MS,
} from './observability.constants';
import {
  HttpMetricSnapshot,
  OperationalMetricsService,
  SyncMetricSnapshot,
} from './operational-metrics.service';

type Availability = 'ok' | 'unavailable';

export interface DependencySnapshot {
  status: Availability;
  latencyMs: number;
}

export interface OAuthProviderSnapshot {
  provider: OAuthProvider;
  success: number;
  failures: number;
  canceled: number;
  failureRate: number;
  outcomes: Record<OAuthOutcome, number>;
}

export interface OAuthPhaseMetricRow {
  provider: OAuthProvider;
  stage: OAuthStage;
  outcome: 'success' | 'canceled' | 'pending' | 'failure';
  code: OAuthOutcome;
  count: number;
}

export interface ImpressionMetricRow {
  decision: 'ACCEPTED' | 'REJECTED' | 'OTHER';
  reason: ImpressionReason;
  count: number;
}

export interface RewardMetricRow {
  entryType: ObservedRewardEntryType;
  count: number;
  points: number;
}

export interface SwitchMetricRow {
  target: ObservedSwitchTarget;
  count: number;
}

export interface ObservabilitySnapshot {
  generatedAt: string;
  windowMinutes: number;
  release: { releaseSha: string; rollbackSha: string };
  http: HttpMetricSnapshot;
  dependencies: { postgres: DependencySnapshot; redis: DependencySnapshot };
  oauth: {
    status: Availability;
    retentionDays: number;
    providers: OAuthProviderSnapshot[];
    phases: OAuthPhaseMetricRow[];
  };
  sync: SyncMetricSnapshot;
  impressions: { status: Availability; rows: ImpressionMetricRow[] };
  rewards: {
    status: Availability;
    rows: RewardMetricRow[];
    unresolvedPending: number;
    oldestPendingAgeSeconds: number;
  };
  switches: { status: Availability; rows: SwitchMetricRow[] };
}

const safeNonNegative = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const safeNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const safeSha = (value: string | undefined): string =>
  value && /^[0-9a-f]{40}$/i.test(value.trim()) ? value.trim().toLowerCase() : 'unknown';

const emptyOAuthOutcomes = (): Record<OAuthOutcome, number> =>
  Object.fromEntries(OAUTH_OUTCOMES.map((outcome) => [outcome, 0])) as Record<OAuthOutcome, number>;

const metricValue = (value: number): string => (Number.isFinite(value) ? String(value) : '0');

const labels = (value: Record<string, string>): string =>
  `{${Object.entries(value)
    .map(([key, item]) => `${key}="${item.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',')}}`;

/** 보호된 운영 스냅샷과 Prometheus exposition을 만든다. 반환값은 집계·고정 code만 포함한다. */
@Injectable()
export class ObservabilityService {
  private readonly windowMinutes: number;
  private readonly oauthRetentionDays: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly runtime: OperationalMetricsService,
  ) {
    const configuredWindow = Number(config.get<string>('OBSERVABILITY_WINDOW_MINUTES', '15'));
    this.windowMinutes = Number.isInteger(configuredWindow) && configuredWindow >= 1 && configuredWindow <= 1_440
      ? configuredWindow
      : 15;
    const configuredRetention = Number(config.get<string>('SOCIAL_METRICS_RETENTION_DAYS', '30'));
    this.oauthRetentionDays = Number.isInteger(configuredRetention) && configuredRetention >= 1 && configuredRetention <= 90
      ? configuredRetention
      : 30;
  }

  private async dependency(check: () => Promise<boolean>): Promise<DependencySnapshot> {
    const started = performance.now();
    try {
      const ok = await check();
      return { status: ok ? 'ok' : 'unavailable', latencyMs: Math.max(0, performance.now() - started) };
    } catch {
      return { status: 'unavailable', latencyMs: Math.max(0, performance.now() - started) };
    }
  }

  private async oauthSnapshot(redisAvailable: boolean): Promise<ObservabilitySnapshot['oauth']> {
    const providers = OAUTH_PROVIDERS.map((provider) => ({
      provider,
      success: 0,
      failures: 0,
      canceled: 0,
      failureRate: 0,
      outcomes: emptyOAuthOutcomes(),
    }));
    if (!redisAvailable) {
      return { status: 'unavailable', retentionDays: this.oauthRetentionDays, providers, phases: [] };
    }

    try {
      const dates = Array.from({ length: this.oauthRetentionDays }, (_, offset) => {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - offset);
        return date.toISOString().slice(0, 10);
      });
      const phases = new Map<string, OAuthPhaseMetricRow>();
      await Promise.all(providers.map(async (snapshot) => {
        const [rows, phaseRow] = await Promise.all([
          Promise.all(dates.map((date) => this.redis.hgetall(`auth:social:metrics:${snapshot.provider}:${date}`))),
          this.redis.hgetall(`auth:social:phase-counter:${snapshot.provider}`),
        ]);
        for (const row of rows) {
          for (const [rawOutcome, rawCount] of Object.entries(row)) {
            const outcome = safeOAuthOutcome(rawOutcome);
            snapshot.outcomes[outcome] += safeNonNegative(rawCount);
          }
        }
        snapshot.success = snapshot.outcomes.SUCCESS;
        snapshot.canceled = snapshot.outcomes.CANCELED;
        snapshot.failures = OAUTH_OUTCOMES
          .filter((outcome) => outcome !== 'SUCCESS' && outcome !== 'CANCELED')
          .reduce((sum, outcome) => sum + snapshot.outcomes[outcome], 0);
        const decided = snapshot.success + snapshot.failures;
        snapshot.failureRate = decided ? snapshot.failures / decided : 0;
        for (const [field, rawCount] of Object.entries(phaseRow)) {
          const separator = field.indexOf(':');
          const rawStage = separator >= 0 ? field.slice(0, separator) : '';
          const rawCode = separator >= 0 ? field.slice(separator + 1) : field;
          if (!OAUTH_STAGES.includes(rawStage as OAuthStage)) continue;
          const stage = rawStage as OAuthStage;
          const code = safeOAuthOutcome(rawCode);
          const outcome = code === 'SUCCESS'
            ? 'success'
            : code === 'CANCELED'
              ? 'canceled'
              : code === 'SIGNUP_REQUIRED'
                ? 'pending'
                : 'failure';
          const key = `${snapshot.provider}:${stage}:${outcome}:${code}`;
          const current = phases.get(key) ?? { provider: snapshot.provider, stage, outcome, code, count: 0 };
          current.count += safeNonNegative(rawCount);
          phases.set(key, current);
        }
      }));
      return {
        status: 'ok',
        retentionDays: this.oauthRetentionDays,
        providers,
        phases: [...phases.values()].sort((a, b) =>
          `${a.provider}:${a.stage}:${a.outcome}:${a.code}`.localeCompare(
            `${b.provider}:${b.stage}:${b.outcome}:${b.code}`,
          )),
      };
    } catch {
      return { status: 'unavailable', retentionDays: this.oauthRetentionDays, providers, phases: [] };
    }
  }

  private async impressionSnapshot(databaseAvailable: boolean): Promise<ObservabilitySnapshot['impressions']> {
    if (!databaseAvailable) return { status: 'unavailable', rows: [] };
    try {
      const raw = await this.dataSource.query(
        `SELECT projected.decision, projected.reason, COUNT(*)::text AS count
         FROM (
           SELECT COALESCE(t."toDecision"::text, e.decision::text) AS decision,
                  COALESCE(t.reason, e.reason) AS reason
           FROM impression_events e
           LEFT JOIN LATERAL (
             SELECT x."toDecision", x.reason FROM impression_decision_transitions x
             WHERE x."impressionEventId" = e.id ORDER BY x.id DESC LIMIT 1
           ) t ON true
           WHERE e."receivedAt" >= NOW() - ($1 * INTERVAL '1 minute')
         ) projected
         GROUP BY projected.decision, projected.reason`,
        [this.windowMinutes],
      ) as Array<{ decision: unknown; reason: unknown; count: unknown }>;
      const combined = new Map<string, ImpressionMetricRow>();
      for (const row of raw) {
        const decision = row.decision === 'ACCEPTED' || row.decision === 'REJECTED' ? row.decision : 'OTHER';
        const reason = decision === 'ACCEPTED' ? 'NONE' : safeImpressionReason(row.reason);
        const key = `${decision}:${reason}`;
        const current = combined.get(key) ?? { decision, reason, count: 0 };
        current.count += safeNonNegative(row.count);
        combined.set(key, current);
      }
      return { status: 'ok', rows: [...combined.values()].sort((a, b) => `${a.decision}:${a.reason}`.localeCompare(`${b.decision}:${b.reason}`)) };
    } catch {
      return { status: 'unavailable', rows: [] };
    }
  }

  private async rewardSnapshot(databaseAvailable: boolean): Promise<ObservabilitySnapshot['rewards']> {
    const empty = {
      status: 'unavailable' as const,
      rows: REWARD_ENTRY_TYPES.map((entryType) => ({ entryType, count: 0, points: 0 })),
      unresolvedPending: 0,
      oldestPendingAgeSeconds: 0,
    };
    if (!databaseAvailable) return empty;
    try {
      const [entries, pending] = await Promise.all([
        this.dataSource.query(
          `SELECT "entryType", COUNT(*)::text AS count, COALESCE(SUM(points), 0)::text AS points
           FROM reward_ledger
           WHERE "createdAt" >= NOW() - ($1 * INTERVAL '1 minute')
             AND "entryType" IN ('ACCRUE_PENDING','ACCRUE_CONFIRM','CLAW_BACK')
           GROUP BY "entryType"`,
          [this.windowMinutes],
        ) as Promise<Array<{ entryType: string; count: unknown; points: unknown }>>,
        this.dataSource.query(
          `SELECT COUNT(*)::text AS count,
                  COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(p."createdAt"))), 0)::text AS age
           FROM reward_ledger p
           JOIN impression_events ie ON ie."idempotencyKey" = p."refIdempotencyKey"
           LEFT JOIN LATERAL (
             SELECT t.* FROM impression_decision_transitions t
             WHERE t."impressionEventId" = ie.id ORDER BY t.id DESC LIMIT 1
           ) dt ON true
           JOIN users u ON u.id = p."userId"
           WHERE p."entryType" = 'ACCRUE_PENDING'
             AND u.status <> 'WITHDRAWN'
             AND COALESCE(dt."toDecision"::text, ie.decision::text) = 'ACCEPTED'
             AND COALESCE(dt."rewardEligible", ie."rewardEligible") = true
             AND NOT EXISTS (
               SELECT 1 FROM reward_ledger x
               WHERE x."refIdempotencyKey" = p."refIdempotencyKey"
                 AND x."entryType" IN ('ACCRUE_CONFIRM','CLAW_BACK')
             )`,
        ) as Promise<Array<{ count: unknown; age: unknown }>>,
      ]);
      const byType = new Map(entries.map((row) => [row.entryType, row]));
      return {
        status: 'ok',
        rows: REWARD_ENTRY_TYPES.map((entryType) => ({
          entryType,
          count: safeNonNegative(byType.get(entryType)?.count),
          points: safeNumber(byType.get(entryType)?.points),
        })),
        unresolvedPending: safeNonNegative(pending[0]?.count),
        oldestPendingAgeSeconds: safeNonNegative(pending[0]?.age),
      };
    } catch {
      return empty;
    }
  }

  private async switchSnapshot(databaseAvailable: boolean): Promise<ObservabilitySnapshot['switches']> {
    if (!databaseAvailable) return { status: 'unavailable', rows: [] };
    try {
      const raw = await this.dataSource.query(
        `SELECT target::text AS target, COUNT(*)::text AS count
         FROM kill_switches WHERE active = true GROUP BY target`,
      ) as Array<{ target: unknown; count: unknown }>;
      const combined = new Map<ObservedSwitchTarget, number>();
      for (const row of raw) {
        const target = safeSwitchTarget(row.target);
        combined.set(target, (combined.get(target) ?? 0) + safeNonNegative(row.count));
      }
      return {
        status: 'ok',
        rows: SWITCH_TARGETS.map((target) => ({ target, count: combined.get(target) ?? 0 })),
      };
    } catch {
      return { status: 'unavailable', rows: [] };
    }
  }

  async snapshot(): Promise<ObservabilitySnapshot> {
    const [postgres, redis] = await Promise.all([
      this.dependency(async () => {
        await this.dataSource.query('SELECT 1');
        return true;
      }),
      this.dependency(async () => (await this.redis.ping()) === 'PONG'),
    ]);
    const [oauth, impressions, rewards, switches] = await Promise.all([
      this.oauthSnapshot(redis.status === 'ok'),
      this.impressionSnapshot(postgres.status === 'ok'),
      this.rewardSnapshot(postgres.status === 'ok'),
      this.switchSnapshot(postgres.status === 'ok'),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      windowMinutes: this.windowMinutes,
      release: {
        releaseSha: safeSha(this.config.get<string>('RELEASE_SHA')),
        rollbackSha: safeSha(this.config.get<string>('ROLLBACK_SHA')),
      },
      http: this.runtime.httpSnapshot(),
      dependencies: { postgres, redis },
      oauth,
      sync: this.runtime.syncSnapshot(),
      impressions,
      rewards,
      switches,
    };
  }

  prometheus(snapshot: ObservabilitySnapshot): string {
    const lines: string[] = [];
    const add = (name: string, value: number, metricLabels: Record<string, string> = {}) => {
      lines.push(`${name}${Object.keys(metricLabels).length ? labels(metricLabels) : ''} ${metricValue(value)}`);
    };
    const describe = (name: string, help: string, type: 'counter' | 'gauge' | 'histogram') => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };

    describe('clawad_build_info', '현재 배포와 롤백 대상의 불변 커밋 정보', 'gauge');
    add('clawad_build_info', 1, {
      release_sha: snapshot.release.releaseSha,
      rollback_sha: snapshot.release.rollbackSha,
    });

    describe('clawad_http_requests_total', '고정 경로군별 HTTP 요청 수', 'counter');
    for (const row of snapshot.http.rows) {
      add('clawad_http_requests_total', row.requests, {
        method: row.method,
        route: row.routeFamily,
        status: row.status,
      });
    }

    describe('clawad_http_request_duration_seconds', '고정 경로군별 HTTP 처리 시간', 'histogram');
    const duration = new Map<string, {
      method: string;
      route: string;
      count: number;
      sumMs: number;
      buckets: Record<string, number>;
    }>();
    for (const row of snapshot.http.rows) {
      const key = `${row.method}:${row.routeFamily}`;
      const total = duration.get(key) ?? {
        method: row.method,
        route: row.routeFamily,
        count: 0,
        sumMs: 0,
        buckets: Object.fromEntries(HTTP_LATENCY_BUCKETS_MS.map((bucket) => [String(bucket), 0])),
      };
      total.count += row.requests;
      total.sumMs += row.durationMsSum;
      for (const bucket of HTTP_LATENCY_BUCKETS_MS) {
        total.buckets[String(bucket)] += row.durationBuckets[String(bucket)] ?? 0;
      }
      duration.set(key, total);
    }
    for (const item of duration.values()) {
      for (const bucket of HTTP_LATENCY_BUCKETS_MS) {
        add('clawad_http_request_duration_seconds_bucket', item.buckets[String(bucket)], {
          method: item.method,
          route: item.route,
          le: String(bucket / 1_000),
        });
      }
      add('clawad_http_request_duration_seconds_bucket', item.count, { method: item.method, route: item.route, le: '+Inf' });
      add('clawad_http_request_duration_seconds_sum', item.sumMs / 1_000, { method: item.method, route: item.route });
      add('clawad_http_request_duration_seconds_count', item.count, { method: item.method, route: item.route });
    }

    describe('clawad_dependency_up', 'API 의존성 준비 상태', 'gauge');
    describe('clawad_dependency_latency_seconds', 'API 의존성 확인 지연', 'gauge');
    for (const [dependency, value] of Object.entries(snapshot.dependencies)) {
      add('clawad_dependency_up', value.status === 'ok' ? 1 : 0, { dependency });
      add('clawad_dependency_latency_seconds', value.latencyMs / 1_000, { dependency });
    }

    describe('clawad_oauth_events_total', '공급자와 start/callback/exchange 단계별 안전한 OAuth 결과', 'counter');
    // 모든 안전 provider/stage/code 조합을 0부터 노출한다. 그래야 첫 장애에서 새 시계열이
    // 생기더라도 Prometheus increase가 기준점 없이 그 증가분을 놓치지 않는다.
    const phaseCounts = new Map(
      snapshot.oauth.phases.map((row) => [`${row.provider}:${row.stage}:${row.code}`, row.count]),
    );
    for (const provider of snapshot.oauth.providers) {
      for (const stage of OAUTH_STAGES) {
        for (const code of OAUTH_OUTCOMES) {
          const result = code === 'SUCCESS'
            ? 'success'
            : code === 'CANCELED'
              ? 'canceled'
              : code === 'SIGNUP_REQUIRED'
                ? 'pending'
                : 'failure';
          const count = phaseCounts.get(`${provider.provider}:${stage}:${code}`) ?? 0;
          add('clawad_oauth_events_total', count, {
            provider: provider.provider,
            stage,
            outcome: result,
            code: code === 'SUCCESS' ? 'NONE' : code === 'CANCELED' ? 'SOCIAL_CANCELED' : code,
          });
        }
      }
    }

    describe('clawad_event_upload_requests_total', 'API 프로세스가 처리한 이벤트 업로드 요청', 'counter');
    add('clawad_event_upload_requests_total', snapshot.sync.uploadRequests);
    describe('clawad_event_uploads_total', '이벤트 업로드 판정 결과', 'counter');
    add('clawad_event_uploads_total', snapshot.sync.acceptedEvents, { outcome: 'accepted' });
    add('clawad_event_uploads_total', snapshot.sync.rejectedEvents, { outcome: 'rejected' });
    describe('clawad_event_upload_delay_seconds', '클라이언트 표시 종료부터 API 수신까지 지연', 'histogram');
    for (const bucket of UPLOAD_DELAY_BUCKETS_MS) {
      add('clawad_event_upload_delay_seconds_bucket', snapshot.sync.uploadDelayBuckets[String(bucket)] ?? 0, {
        le: String(bucket / 1_000),
      });
    }
    add('clawad_event_upload_delay_seconds_bucket', snapshot.sync.uploadDelaySamples, { le: '+Inf' });
    add('clawad_event_upload_delay_seconds_sum', snapshot.sync.uploadDelayMsSum / 1_000);
    add('clawad_event_upload_delay_seconds_count', snapshot.sync.uploadDelaySamples);

    describe('clawad_impression_decisions_total', '최근 관측 창의 최종 노출 판정', 'gauge');
    for (const row of snapshot.impressions.rows) {
      add('clawad_impression_decisions_total', row.count, { decision: row.decision, reason: row.reason });
    }

    describe('clawad_reward_entries_total', '최근 관측 창의 리워드 원장 항목', 'gauge');
    describe('clawad_reward_points_total', '최근 관측 창의 리워드 포인트 합계', 'gauge');
    for (const row of snapshot.rewards.rows) {
      add('clawad_reward_entries_total', row.count, { entry_type: row.entryType });
      add('clawad_reward_points_total', row.points, { entry_type: row.entryType });
    }
    describe('clawad_reward_pending_unresolved', '아직 확정 또는 회수되지 않은 pending 수', 'gauge');
    add('clawad_reward_pending_unresolved', snapshot.rewards.unresolvedPending);
    describe('clawad_reward_pending_oldest_seconds', '가장 오래된 미해결 pending의 나이', 'gauge');
    add('clawad_reward_pending_oldest_seconds', snapshot.rewards.oldestPendingAgeSeconds);

    describe('clawad_kill_switch_active', '대상 유형별 활성 kill switch 수', 'gauge');
    for (const row of snapshot.switches.rows) {
      add('clawad_kill_switch_active', row.count, { target: row.target });
    }

    describe('clawad_observability_query_up', '운영 집계별 조회 성공 여부', 'gauge');
    add('clawad_observability_query_up', snapshot.oauth.status === 'ok' ? 1 : 0, { section: 'oauth' });
    add('clawad_observability_query_up', snapshot.impressions.status === 'ok' ? 1 : 0, { section: 'impressions' });
    add('clawad_observability_query_up', snapshot.rewards.status === 'ok' ? 1 : 0, { section: 'rewards' });
    add('clawad_observability_query_up', snapshot.switches.status === 'ok' ? 1 : 0, { section: 'switches' });

    return `${lines.join('\n')}\n`;
  }
}
