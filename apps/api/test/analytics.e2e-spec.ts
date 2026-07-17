import './setup-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { loginBootstrapAdmin } from './admin-helper';
import { AppModule } from '../src/app.module';
import { ClickEvent } from '../src/entities/click-event.entity';
import { ImpressionDecision, ImpressionEvent } from '../src/entities/impression-event.entity';
import { ImpressionDecisionTransition } from '../src/entities/impression-decision-transition.entity';
import { AdServeLog } from '../src/entities/ad-serve-log.entity';

describe('CLAW-25 관리자 분석 API', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  const campaignId = randomUUID();
  const creativeId = randomUUID();
  const userId = randomUUID();
  const from = '2020-01-01T00:00:00.000Z';
  const to = '2030-12-31T00:00:00.000Z';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    adminToken = await loginBootstrapAdmin(app);

    const events = dataSource.getRepository(ImpressionEvent);
    const accepted = await events.save(events.create({
      idempotencyKey: randomUUID(), tokenJti: randomUUID(), campaignId, creativeId, campaignType: 'PAID', userId,
      machineId: 'analytics-machine', sequence: 1, startedAt: Date.parse('2026-07-01T00:00:00.000Z'), endedAt: Date.parse('2026-07-01T00:00:05.000Z'),
      renderStarted: Date.parse('2026-07-01T00:00:00.000Z') - 500,
      decision: ImpressionDecision.ACCEPTED, billed: true, rewardEligible: true, companyFunded: false,
    }));
    // 광고 결정(발급) 3건: 표시 시작 1건(위 accepted)만 renderStarted가 있어 손실 구간이 드러난다.
    const serveLog = dataSource.getRepository(AdServeLog);
    await serveLog.save([
      serveLog.create({ campaignId, campaignType: 'PAID', creativeId }),
      serveLog.create({ campaignId, campaignType: 'PAID', creativeId }),
      serveLog.create({ campaignId, campaignType: 'PAID', creativeId }),
    ]);
    const rejected = await events.save(events.create({
      idempotencyKey: randomUUID(), tokenJti: randomUUID(), campaignId, creativeId, campaignType: 'PAID', userId,
      machineId: 'analytics-machine', sequence: 2, startedAt: Date.parse('2026-07-01T01:00:00.000Z'), endedAt: Date.parse('2026-07-01T01:00:05.000Z'),
      decision: ImpressionDecision.ACCEPTED, billed: true, rewardEligible: true, companyFunded: false,
    }));
    await dataSource.getRepository(ImpressionDecisionTransition).save({
      impressionEventId: rejected.id, fromDecision: ImpressionDecision.ACCEPTED, toDecision: ImpressionDecision.REJECTED,
      reason: 'CONCURRENT_USER_IMPRESSION', billed: false, rewardEligible: false, companyFunded: false,
    });
    await dataSource.getRepository(ClickEvent).save({
      clickJti: randomUUID(), campaignId, creativeId, userId, machineId: 'analytics-machine', sequence: null, clientVersion: null,
      createdAt: new Date('2026-07-01T00:01:00.000Z'),
    });
    void accepted;
  });

  afterAll(async () => app.close());
  const api = () => request(app.getHttpServer());
  const admin = (r: request.Test) => r.set('Authorization', `Bearer ${adminToken}`);
  const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&campaignId=${campaignId}`;

  it('최신 판정·클릭을 합산하고 원시 식별자를 반환하지 않는다', async () => {
    const res = await admin(api().get(`/internal/v1/analytics/summary?${query}`)).expect(200);
    expect(res.body).toMatchObject({ validImpressions: 1, invalidImpressions: 1, clicks: 1, uniqueClicks: 1, billedImpressions: 1 });
    expect(res.body.ctr).toBe(1);
    expect(res.body.invalidReasons.CONCURRENT_USER_IMPRESSION).toBe(1);
    expect(res.body).not.toHaveProperty('userId');
    expect(res.body).not.toHaveProperty('machineId');
  });

  it('시계열·소재 분해·CSV가 같은 집계값을 제공한다', async () => {
    const series = await admin(api().get(`/internal/v1/analytics/time-series?${query}`)).expect(200);
    expect(series.body.reduce((sum: number, row: { validImpressions: number }) => sum + row.validImpressions, 0)).toBe(1);
    expect(series.body.reduce((sum: number, row: { clicks: number }) => sum + row.clicks, 0)).toBe(1);
    const breakdown = await admin(api().get(`/internal/v1/analytics/breakdown?${query}&dimension=creative`)).expect(200);
    expect(breakdown.body[0]).toMatchObject({ creativeId, validImpressions: 1, clicks: 1 });
    const csv = await admin(api().get(`/internal/v1/analytics/export.csv?${query}`)).expect(200);
    expect(csv.text).toContain('validImpressions');
    expect(csv.text).not.toContain(userId);
  });

  it('노출 퍼널이 결정→표시→유효→거절 단계와 손실 구간을 집계한다 (CLAW-71)', async () => {
    const res = await admin(api().get(`/internal/v1/analytics/funnel?${query}`)).expect(200);
    expect(res.body.stages).toMatchObject({ decided: 3, rendered: 1, received: 2, valid: 1, rejected: 1 });
    // 발급 3 중 표시 신호 1 → 표시 안 됨 2, 표시 1 중 유효 1 → 유효 실패 0.
    expect(res.body.loss).toMatchObject({ decidedNotRendered: 2, renderedNotValid: 0 });
    expect(res.body.conversion.decidedToRendered).toBeCloseTo(1 / 3, 5);
    expect(res.body.rejectedReasons.CONCURRENT_USER_IMPRESSION).toBe(1);
    expect(res.body).not.toHaveProperty('userId');
    expect(res.body).not.toHaveProperty('machineId');
  });

  it('funnel도 인증 없이는 401, 잘못된 기간은 400이다', async () => {
    await api().get(`/internal/v1/analytics/funnel?${query}`).expect(401);
    await admin(api().get('/internal/v1/analytics/funnel?from=bad&to=also-bad')).expect(400);
  });

  it('권한 없음·잘못된 기간은 안전하게 거절한다', async () => {
    await api().get(`/internal/v1/analytics/summary?${query}`).expect(401);
    await admin(api().get('/internal/v1/analytics/summary?from=bad&to=also-bad')).expect(400);
  });
});
