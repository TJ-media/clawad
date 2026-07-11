import './setup-env';
import { loginBootstrapAdmin } from './admin-helper';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { loadPolicy } from '../src/common/policy';
import { ConsentType } from '../src/entities/consent.entity';
import { CampaignStatus, CampaignType } from '../src/entities/campaign.entity';
import { BillingEntryType } from '../src/entities/billing-ledger.entity';
import { ImpressionEvent, ImpressionDecision } from '../src/entities/impression-event.entity';
import { KillSwitchTarget } from '../src/entities/kill-switch.entity';

let adminToken: string;
const POLICY = loadPolicy();
const MIN_VIEW = POLICY.impression.minViewMs;

const newMachineId = () => randomBytes(16).toString('hex');
const newEmail = () => `ev-${randomUUID()}@example.test`;

describe('CLAW-6 노출 검증 파이프라인 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    adminToken = await loginBootstrapAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const admin = (r: request.Test) => r.set('Authorization', `Bearer ${adminToken}`);

  async function makeUserWithMachine() {
    const res = await api()
      .post('/v1/auth/signup')
      .send({
        email: newEmail(),
        password: 'correct-horse-battery',
        consents: [
          { type: ConsentType.TERMS_OF_SERVICE, granted: true, documentVersion: 'v0' },
          { type: ConsentType.PRIVACY_POLICY, granted: true, documentVersion: 'v0' },
        ],
      })
      .expect(201);
    const accessToken = res.body.accessToken as string;
    const machineId = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId }).expect(200);
    return { accessToken, machineId };
  }

  async function activeCampaign(type = CampaignType.PAID, price = 2, budget = 100000) {
    const adv = await admin(api().post('/internal/v1/advertisers')).send({ name: `adv-${randomUUID().slice(0, 8)}` });
    const cam = await admin(api().post('/internal/v1/campaigns')).send({
      advertiserId: adv.body.id,
      name: 'ev',
      type,
      pricePerImpressionKrw: type === CampaignType.PAID ? price : 0,
    });
    const cr = await admin(api().post(`/internal/v1/campaigns/${cam.body.id}/creatives`)).send({
      text: '광고 문구',
      brand: '브랜드',
    });
    await admin(api().post(`/internal/v1/creatives/${cr.body.id}/review`)).send({ approve: true }).expect(200);
    for (const to of [CampaignStatus.PENDING_REVIEW, CampaignStatus.APPROVED, CampaignStatus.ACTIVE]) {
      await admin(api().post(`/internal/v1/campaigns/${cam.body.id}/transition`)).send({ to }).expect(200);
    }
    // 예산 0은 아예 충전하지 않는다(credit은 양수만 받는다) — BUDGET_EXHAUSTED 경로 검증용.
    if (type === CampaignType.PAID && budget > 0) {
      await admin(api().post(`/internal/v1/campaigns/${cam.body.id}/budget/credit`))
        .send({ entryType: BillingEntryType.DEPOSIT, amountKrw: budget })
        .expect(201);
    }
    return { campaignId: cam.body.id as string, advertiserId: adv.body.id as string };
  }

  /** ad-decision으로 실제 서명 토큰을 받는다. 클라이언트는 토큰을 만들 수 없다. */
  async function getToken(accessToken: string, machineId: string) {
    // 각 테스트는 서빙 풀을 좁히기 위해 직전에 만든 캠페인만 ACTIVE로 둔다.
    const res = await api()
      .get('/v1/ad-decision')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-clawad-machine-id', machineId)
      .expect(200);
    return res.body.serveToken as string;
  }

  const onlyThisCampaignActive = async (campaignId: string) => {
    await dataSource.query(`UPDATE campaigns SET status = 'ENDED' WHERE status = 'ACTIVE' AND id <> $1`, [campaignId]);
  };

  const postEvents = (accessToken: string, machineId: string, events: object[]) =>
    api().post('/v1/events').set('Authorization', `Bearer ${accessToken}`).send(events);

  const factEvent = (serveToken: string, machineId: string, seq: number, overrides: object = {}) => {
    const startedAt = Date.now();
    return {
      serveToken,
      sequence: seq,
      machineId,
      startedAt,
      endedAt: startedAt + MIN_VIEW + 500,
      clientVersion: '0.1.0',
      ...overrides,
    };
  };

  it('토큰 없이 events 호출 시 401', async () => {
    await api().post('/v1/events').send([]).expect(401);
  });

  it('유효한 노출 1건을 인정하고 예산을 차감한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body).toEqual({ received: 1, accepted: 1, rejected: {} });

    const budget = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(budget.body.availableKrw).toBe(100000 - 2);
  });

  it('같은 노출 재전송은 멱등이다 — 중복 적립·중복 과금 없음', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);
    const event = factEvent(token, machineId, 1);

    const first = await postEvents(accessToken, machineId, [event]).expect(200);
    const second = await postEvents(accessToken, machineId, [event]).expect(200);

    expect(first.body.accepted).toBe(1);
    expect(second.body.accepted).toBe(1); // 멱등: 이전 결과를 그대로 반환
    const budget = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(budget.body.availableKrw).toBe(100000 - 2); // 한 번만 차감
  });

  it('클라이언트가 금액 필드를 실어도 무시한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    const res = await postEvents(accessToken, machineId, [
      factEvent(token, machineId, 1, { gross: 9999, userShare: 5000, rewardAmount: 300, userId: randomUUID() }),
    ]).expect(200);
    expect(res.body.accepted).toBe(1);

    const row = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    // userId는 세션에서 확정된다. 본문의 자가신고 userId를 쓰지 않는다.
    expect(row.userId).not.toBe('00000000-0000-0000-0000-000000000000');
    expect(row).not.toHaveProperty('gross');
  });

  it('viewability 미만은 BAD_INTERVAL', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);
    const started = Date.now();

    const res = await postEvents(accessToken, machineId, [
      { serveToken: token, sequence: 1, machineId, startedAt: started, endedAt: started + 1000 },
    ]).expect(200);
    expect(res.body.accepted).toBe(0);
    expect(res.body.rejected.BAD_INTERVAL).toBe(1);
  });

  it('변조된 토큰은 BAD_TOKEN', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);
    const tampered = token.slice(0, -4) + 'AAAA';

    const res = await postEvents(accessToken, machineId, [factEvent(tampered, machineId, 1)]).expect(200);
    expect(res.body.rejected.BAD_TOKEN).toBe(1);
  });

  it('다른 기기의 토큰을 쓰면 BAD_TOKEN (토큰-기기 바인딩)', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    const otherMachine = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: otherMachine }).expect(200);

    const res = await postEvents(accessToken, otherMachine, [factEvent(token, otherMachine, 1)]).expect(200);
    expect(res.body.rejected.BAD_TOKEN).toBe(1);
  });

  it('같은 토큰을 다른 sequence로 재사용하면 TOKEN_REUSE', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 2)]).expect(200);
    expect(res.body.rejected.TOKEN_REUSE).toBe(1);
  });

  it('폐기된 토큰은 서명이 유효해도 인정하지 않는다 (TOKEN_REVOKED)', async () => {
    // 로컬 캐시 유실 복구로 폐기(revokeUnused)한 토큰은 registry에서 사라진다.
    // 서명은 여전히 유효하고 원장에도 없지만, registry 대조로 거절돼야 한다.
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    // 미사용 토큰 전체 폐기
    await api()
      .delete('/v1/ad-decision/prefetched-tokens')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-clawad-machine-id', machineId)
      .expect(200);

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body.accepted).toBe(0);
    expect(res.body.rejected.TOKEN_REVOKED).toBe(1);
  });

  it('같은 계정의 겹친 노출은 한 건만 인정한다 (CONCURRENT_USER_IMPRESSION)', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const m2 = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: m2 }).expect(200);

    const t1 = await getToken(accessToken, machineId);
    const t2 = await getToken(accessToken, m2);
    const started = Date.now();
    const window = { startedAt: started, endedAt: started + MIN_VIEW + 500 };

    const res = await postEvents(accessToken, machineId, [
      { serveToken: t1, sequence: 1, machineId, ...window },
      { serveToken: t2, sequence: 2, machineId: m2, ...window },
    ]).expect(200);

    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected.CONCURRENT_USER_IMPRESSION).toBe(1);
  });

  it('동시 요청에서도 겹친 노출은 한 건만 인정한다 (advisory 잠금)', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const m2 = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: m2 }).expect(200);

    const t1 = await getToken(accessToken, machineId);
    const t2 = await getToken(accessToken, m2);
    const started = Date.now();
    const window = { startedAt: started, endedAt: started + MIN_VIEW + 500 };

    const [r1, r2] = await Promise.all([
      postEvents(accessToken, machineId, [{ serveToken: t1, sequence: 1, machineId, ...window }]),
      postEvents(accessToken, m2, [{ serveToken: t2, sequence: 2, machineId: m2, ...window }]),
    ]);
    const totalAccepted = r1.body.accepted + r2.body.accepted;
    expect(totalAccepted).toBe(1); // 동시 도착에도 한 건만
  });

  it('킬스위치에 걸린 캠페인의 노출은 KILLED', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    await admin(api().post('/internal/v1/kill-switch'))
      .send({ target: KillSwitchTarget.CAMPAIGN, targetId: campaignId, reason: 'test' })
      .expect(201);

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body.rejected.KILLED).toBe(1);
  });

  it('BUDGET_EXHAUSTED: 예산이 소진되면 과금 없이 인정하고 회사 재원으로 표시한다', async () => {
    // 헤드룸(단가 2 × 미사용 토큰 3 = 6)을 통과할 예산으로 토큰을 발급받은 뒤,
    // 노출 검증 전에 예산을 소진시킨다 — 사용자가 이미 광고를 본 상황을 재현.
    const { campaignId, advertiserId } = await activeCampaign(CampaignType.PAID, 2, 6);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    // 예산을 0으로 드레인(CAPTURE 음수 append — append-only 허용).
    await dataSource.query(
      `INSERT INTO billing_ledger ("advertiserId","campaignId","entryType","amountKrw") VALUES ($1,$2,'CAPTURE',-6)`,
      [advertiserId, campaignId],
    );

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body.accepted).toBe(1); // 사용자에게 전가하지 않는다 — ACCEPTED

    const row = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    expect(row.decision).toBe(ImpressionDecision.ACCEPTED);
    expect(row.billed).toBe(false); // 광고주 과금 없음
    expect(row.companyFunded).toBe(true); // 회사 재원 리워드
    expect(row.rewardEligible).toBe(true);

    const budget = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(budget.body.availableKrw).toBe(0); // 이미 0, 추가 차감 없음
  });

  it('HOUSE 캠페인은 인정되지만 과금하지 않는다', async () => {
    const { campaignId } = await activeCampaign(CampaignType.HOUSE);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body.accepted).toBe(1);
    const row = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    expect(row.billed).toBe(false);
    expect(row.rewardEligible).toBe(false); // HOUSE 기본 미적립(rewardPolicyId 없음)
  });

  it('원장은 append-only — DB가 UPDATE·DELETE를 거부한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);
    await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);

    const row = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    await expect(
      dataSource.query(`UPDATE impression_events SET decision='REJECTED' WHERE id=$1`, [row.id]),
    ).rejects.toThrow(/append-only/);
    await expect(dataSource.query(`DELETE FROM impression_events WHERE id=$1`, [row.id])).rejects.toThrow(/append-only/);
  });

  it('abuse-report가 사유별 카운트를 집계한다', async () => {
    const report = await admin(api().get('/internal/v1/abuse-report')).expect(200);
    expect(report.body).toHaveProperty('total');
    expect(report.body).toHaveProperty('accepted');
    expect(report.body).toHaveProperty('byReason');
    expect(typeof report.body.byReason).toBe('object');
  });
});

/** 서명 토큰 payload에서 jti를 꺼낸다(테스트 검증용). */
function decodeJti(serveToken: string): string {
  const payload = JSON.parse(Buffer.from(serveToken.split('.')[0], 'base64url').toString('utf8'));
  return payload.jti;
}
