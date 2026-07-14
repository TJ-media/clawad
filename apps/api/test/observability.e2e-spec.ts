import './setup-env';
import { Controller, Get, INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource, QueryFailedError } from 'typeorm';
import { loginBootstrapAdmin } from './admin-helper';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/common/redis.module';
import { OperationalMetricsService } from '../src/observability/operational-metrics.service';

const MONITORING_TOKEN = 'monitoring-e2e-token-'.padEnd(48, 'x');
const RELEASE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);
const FORBIDDEN_MARKER = 'secret-marker-do-not-expose';
const EXCEPTION_MARKERS = [
  'token-marker-must-not-be-logged',
  'user-marker-must-not-be-logged',
  'machine-marker-must-not-be-logged',
  'client-version-marker-must-not-be-logged',
] as const;

@Controller('__test/safe-exception')
class SafeExceptionProbeController {
  @Get()
  fail(): never {
    throw new QueryFailedError(
      'INSERT INTO sensitive_table (token) VALUES ($1)',
      [...EXCEPTION_MARKERS],
      new Error(EXCEPTION_MARKERS[3]),
    );
  }
}

process.env.MONITORING_TOKEN = MONITORING_TOKEN;
process.env.RELEASE_SHA = RELEASE_SHA;
process.env.ROLLBACK_SHA = ROLLBACK_SHA;
process.env.OBSERVABILITY_WINDOW_MINUTES = '60';

describe('CLAW-65 알파 관측성', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: Redis;
  let adminToken: string;
  let observedUserId: string;
  const oauthKeys: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [SafeExceptionProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    redis = app.get<Redis>(REDIS_CLIENT);
    adminToken = await loginBootstrapAdmin(app);

    const date = new Date().toISOString().slice(0, 10);
    for (const provider of ['GOOGLE', 'KAKAO', 'NAVER']) {
      const key = `auth:social:metrics:${provider}:${date}`;
      const phaseKey = `auth:social:phase-metrics:${provider}:${date}`;
      const phaseCounterKey = `auth:social:phase-counter:${provider}`;
      oauthKeys.push(key, phaseKey, phaseCounterKey);
      await redis.del(key, phaseKey, phaseCounterKey);
    }
    await redis.hset(oauthKeys[0], {
      SUCCESS: '2',
      CANCELED: '1',
      SOCIAL_PROVIDER_UNAVAILABLE: '1',
      [FORBIDDEN_MARKER]: '3',
    });
    await redis.hset(oauthKeys[1], {
      'start:SUCCESS': '2',
      'callback:SOCIAL_PROVIDER_UNAVAILABLE': '1',
      'exchange:SUCCESS': '1',
      'exchange:SIGNUP_REQUIRED': '1',
      [`start:${FORBIDDEN_MARKER}`]: '1',
    });
    await redis.hset(oauthKeys[2], {
      'start:SUCCESS': '12',
      'callback:SOCIAL_PROVIDER_UNAVAILABLE': '3',
      'exchange:SUCCESS': '4',
      'exchange:SIGNUP_REQUIRED': '2',
      [`start:${FORBIDDEN_MARKER}`]: '9',
    });

    const userId = randomUUID();
    observedUserId = userId;
    const campaignId = randomUUID();
    const acceptedKey = `obs-accepted-${randomUUID()}`;
    const rejectedKey = `obs-rejected-${randomUUID()}`;
    const pendingRef = `obs-pending-${randomUUID()}`;
    const now = Date.now();
    await dataSource.query(
      `INSERT INTO users (id,email,status,"withdrawnAt","createdAt","updatedAt")
       VALUES ($1,NULL,'ACTIVE',NULL,NOW(),NOW())`,
      [userId],
    );
    await dataSource.query(
      `INSERT INTO impression_events
       ("idempotencyKey","tokenJti","campaignId","campaignType","userId","machineId",sequence,"startedAt","endedAt",decision,reason,billed,"rewardEligible","companyFunded")
       VALUES ($1,$2,$3,'PAID',$4,$5,1,$6,$7,'ACCEPTED',NULL,true,true,false),
              ($8,$9,$3,'PAID',$4,$5,2,$6,$7,'REJECTED',$10,false,false,false),
              ($11,$12,$3,'PAID',$4,$5,3,$6,$7,'ACCEPTED',NULL,false,true,false)`,
      [
        acceptedKey,
        randomUUID(),
        campaignId,
        userId,
        `machine-${FORBIDDEN_MARKER}`,
        now - 6_000,
        now - 1_000,
        rejectedKey,
        randomUUID(),
        FORBIDDEN_MARKER.slice(0, 40),
        pendingRef,
        randomUUID(),
      ],
    );

    await dataSource.query(
      `INSERT INTO reward_ledger ("userId","entryType",points,"refIdempotencyKey") VALUES
       ($1,'ACCRUE_PENDING',10,$2),
       ($1,'ACCRUE_CONFIRM',10,$2),
       ($1,'CLAW_BACK',-10,$2),
       ($1,'ACCRUE_PENDING',5,$3)`,
      [userId, acceptedKey, pendingRef],
    );
    await dataSource.query(
      `INSERT INTO kill_switches (target,"targetId",active,reason)
       VALUES ('CAMPAIGN',$1,true,$2)`,
      [campaignId, FORBIDDEN_MARKER],
    );

    const runtime = app.get(OperationalMetricsService);
    runtime.recordSyncUpload(
      { received: 3, accepted: 2, rejected: { BAD_TOKEN: 1 } },
      [{ endedAt: now - 1_000 }, { endedAt: now - 2_000 }, { endedAt: now - 3_000 }],
      now,
    );
  });

  afterAll(async () => {
    if (redis) await redis.del(...oauthKeys);
    if (app) await app.close();
  });

  const api = () => request(app.getHttpServer());

  it('알 수 없는 DB 예외는 SQL·파라미터 없이 고정 코드만 기록한다', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const response = await api().get('/__test/safe-exception').expect(500);
      expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
      expect(logger.mock.calls).toEqual([['UNHANDLED_REQUEST_EXCEPTION']]);
      const logged = JSON.stringify(logger.mock.calls);
      for (const marker of EXCEPTION_MARKERS) expect(logged).not.toContain(marker);
      expect(logged).not.toContain('sensitive_table');
    } finally {
      logger.mockRestore();
    }
  });

  it('관리자 보호 스냅샷이 API·의존성·OAuth·sync·원장 집계를 반환한다', async () => {
    await api().get('/health/live').expect(200);
    await api()
      .get(`/not-a-real-route/${FORBIDDEN_MARKER}`)
      .query({ code: FORBIDDEN_MARKER, email: `${FORBIDDEN_MARKER}@example.test` })
      .expect(404);
    await api().get(`/v1/click/${FORBIDDEN_MARKER}`).expect(409);

    await api().get('/internal/v1/observability/snapshot').expect(401);
    const response = await api()
      .get('/internal/v1/observability/snapshot')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.release).toEqual({ releaseSha: RELEASE_SHA, rollbackSha: ROLLBACK_SHA });
    expect(response.body.dependencies).toMatchObject({ postgres: { status: 'ok' }, redis: { status: 'ok' } });
    expect(response.body.http.requests).toBeGreaterThanOrEqual(3);
    expect(response.body.http.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ routeFamily: '/health', method: 'GET', status: '200' }),
        expect.objectContaining({ routeFamily: '/v1/click', method: 'GET', status: '409' }),
        expect.objectContaining({ routeFamily: 'other', method: 'GET', status: '404' }),
      ]),
    );

    const google = response.body.oauth.providers.find((item: { provider: string }) => item.provider === 'GOOGLE');
    expect(google).toMatchObject({ success: 2, canceled: 1, failures: 4 });
    expect(google.outcomes).toMatchObject({ SOCIAL_PROVIDER_UNAVAILABLE: 1, OTHER: 3 });
    expect(response.body.oauth.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'GOOGLE', stage: 'start', outcome: 'success', code: 'SUCCESS' }),
        expect.objectContaining({ provider: 'GOOGLE', stage: 'callback', outcome: 'failure', code: 'SOCIAL_PROVIDER_UNAVAILABLE' }),
        expect.objectContaining({ provider: 'GOOGLE', stage: 'exchange', outcome: 'pending', code: 'SIGNUP_REQUIRED' }),
        expect.objectContaining({ provider: 'GOOGLE', stage: 'start', outcome: 'failure', code: 'OTHER' }),
      ]),
    );
    expect(response.body.sync).toMatchObject({
      uploadRequests: 1,
      receivedEvents: 3,
      acceptedEvents: 2,
      rejectedEvents: 1,
      uploadDelaySamples: 3,
    });
    expect(response.body.impressions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decision: 'ACCEPTED', reason: 'NONE' }),
        expect.objectContaining({ decision: 'REJECTED', reason: 'OTHER' }),
      ]),
    );
    expect(response.body.rewards.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryType: 'ACCRUE_PENDING' }),
        expect.objectContaining({ entryType: 'ACCRUE_CONFIRM' }),
        expect.objectContaining({ entryType: 'CLAW_BACK' }),
      ]),
    );
    expect(response.body.rewards.unresolvedPending).toBeGreaterThanOrEqual(1);
    expect(response.body.switches.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'CAMPAIGN', count: expect.any(Number) })]),
    );

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(FORBIDDEN_MARKER);
    expect(serialized).not.toContain('not-a-real-route');
    expect(serialized).not.toContain('example.test');
  });

  it('지원 provider가 비활성이면 start 실패를 안전 코드로 기록한다', async () => {
    const before = Number(await redis.hget(oauthKeys[1], 'start:PROVIDER_NOT_ENABLED') ?? 0);
    const counterBefore = Number(await redis.hget(oauthKeys[2], 'start:PROVIDER_NOT_ENABLED') ?? 0);
    const response = await api()
      .post('/v1/auth/social/google/start')
      .send({ intent: 'LOGIN', returnTarget: 'http://localhost:3111/cb' })
      .expect(400);
    expect(response.body.error).toBe('PROVIDER_NOT_ENABLED');
    expect(Number(await redis.hget(oauthKeys[1], 'start:PROVIDER_NOT_ENABLED'))).toBe(before + 1);
    expect(Number(await redis.hget(oauthKeys[2], 'start:PROVIDER_NOT_ENABLED'))).toBe(counterBefore + 1);
    expect(await redis.ttl(oauthKeys[2])).toBe(-1);
  });

  it('최신 판정에서 제외된 reprojection pending은 장기 미해결로 세지 않는다', async () => {
    const before = await api()
      .get('/internal/v1/observability/snapshot')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const staleRef = `obs-stale-${randomUUID()}`;
    const campaignId = randomUUID();
    const now = Date.now();
    const inserted = await dataSource.query(
      `INSERT INTO impression_events
       ("idempotencyKey","tokenJti","campaignId","campaignType","userId","machineId",sequence,"startedAt","endedAt",decision,reason,billed,"rewardEligible","companyFunded")
       VALUES ($1,$2,$3,'PAID',$4,$5,99,$6,$7,'ACCEPTED',NULL,true,true,false)
       RETURNING id`,
      [staleRef, randomUUID(), campaignId, observedUserId, '0'.repeat(32), now - 6_000, now - 1_000],
    );
    const eventId = String(inserted[0].id);
    await dataSource.query(
      `INSERT INTO reward_ledger ("userId","entryType",points,"refIdempotencyKey",reason) VALUES
       ($1,'ACCRUE_PENDING',7,$2,NULL),
       ($1,'REPROJECTION_ADJUST',-7,$3,'CONCURRENT_REPROJECTION_PENDING')`,
      [observedUserId, staleRef, `reproject-reward:${eventId}:test`],
    );
    await dataSource.query(
      `INSERT INTO impression_decision_transitions
       ("impressionEventId","fromDecision","toDecision",reason,billed,"rewardEligible","companyFunded")
       VALUES ($1,'ACCEPTED','REJECTED','CONCURRENT_REPROJECTION',false,false,false)`,
      [eventId],
    );

    const after = await api()
      .get('/internal/v1/observability/snapshot')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(after.body.rewards.unresolvedPending).toBe(before.body.rewards.unresolvedPending);
  });

  it('Prometheus endpoint는 모니터 토큰을 요구하고 고정 label만 노출한다', async () => {
    await api().get('/monitor/v1/metrics').expect(401);
    await api().get('/monitor/v1/metrics').set('Authorization', 'Bearer wrong-token').expect(401);
    const response = await api()
      .get('/monitor/v1/metrics')
      .set('Authorization', `Bearer ${MONITORING_TOKEN}`)
      .expect(200);

    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.text).toContain(`clawad_build_info{release_sha="${RELEASE_SHA}",rollback_sha="${ROLLBACK_SHA}"} 1`);
    expect(response.text).toContain('clawad_http_requests_total{method="GET",route="/health",status="200"}');
    expect(response.text).toContain('clawad_dependency_up{dependency="postgres"} 1');
    expect(response.text).toContain('clawad_oauth_events_total{provider="GOOGLE",stage="start",outcome="success",code="NONE"}');
    expect(response.text).toContain(
      'clawad_oauth_events_total{provider="GOOGLE",stage="start",outcome="success",code="NONE"} 12',
    );
    expect(response.text).toContain('clawad_oauth_events_total{provider="GOOGLE",stage="exchange",outcome="pending",code="SIGNUP_REQUIRED"}');
    expect(response.text).toContain(
      'clawad_oauth_events_total{provider="NAVER",stage="exchange",outcome="failure",code="OTHER"} 0',
    );
    expect(response.text).toContain('clawad_event_upload_delay_seconds_bucket');
    expect(response.text).toContain('clawad_impression_decisions_total');
    expect(response.text).toContain('clawad_reward_entries_total{entry_type="ACCRUE_PENDING"}');
    expect(response.text).toContain('clawad_kill_switch_active{target="CAMPAIGN"}');
    expect(response.text).not.toContain(FORBIDDEN_MARKER);
    expect(response.text).not.toContain(MONITORING_TOKEN);
    expect(response.text).not.toContain(adminToken);
  });
});
