import './setup-env';
import { loginBootstrapAdmin } from './admin-helper';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { loadPolicy } from '../src/common/policy';
import { REDIS_CLIENT } from '../src/common/redis.module';
import { CampaignStatus, CampaignType } from '../src/entities/campaign.entity';
import { BillingEntryType } from '../src/entities/billing-ledger.entity';
import { ImpressionEvent, ImpressionDecision } from '../src/entities/impression-event.entity';
import { KillSwitchTarget } from '../src/entities/kill-switch.entity';
import { Machine, MachineStatus } from '../src/entities/machine.entity';
import { RewardEntryType, RewardLedgerEntry } from '../src/entities/reward-ledger.entity';
import { seedUser } from './social-helper';
import { KillSwitchService } from '../src/events/kill-switch.service';

let adminToken: string;
const POLICY = loadPolicy();
const MIN_VIEW = POLICY.impression.minViewMs;

const newMachineId = () => randomBytes(16).toString('hex');

describe('CLAW-6·CLAW-29 노출 검증·어뷰징 시나리오 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: { flushdb(): Promise<string> };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    redis = app.get(REDIS_CLIENT);
    adminToken = await loginBootstrapAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const admin = (r: request.Test) => r.set('Authorization', `Bearer ${adminToken}`);
  const enableSwitch = (target: KillSwitchTarget, targetId: string) =>
    admin(api().post('/internal/v1/kill-switch'))
      .send({ target, targetId, reasonCode: 'ALPHA_INCIDENT_TEST', incidentRef: 'CLAW-65' })
      .expect(201);
  const disableSwitch = (target: KillSwitchTarget, targetId: string) =>
    admin(api().delete('/internal/v1/kill-switch'))
      .send({ target, targetId, reasonCode: 'ALPHA_RECOVERY_TEST', incidentRef: 'CLAW-65' })
      .expect(200);

  async function makeUserWithMachine() {
    const { accessToken, userId } = await seedUser(app);
    const machineId = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId }).expect(200);
    return { accessToken, userId, machineId };
  }

  async function activeCampaign(
    type = CampaignType.PAID,
    price = 2,
    budget = 100000,
    advertiserDailyLimit?: number,
    landingUrl?: string,
    rewardPolicyId?: string,
  ) {
    const adv = await admin(api().post('/internal/v1/advertisers')).send({
      name: `adv-${randomUUID().slice(0, 8)}`,
      ...(advertiserDailyLimit == null ? {} : { dailyImpressionLimit: advertiserDailyLimit }),
    });
    const cam = await admin(api().post('/internal/v1/campaigns')).send({
      advertiserId: adv.body.id,
      name: 'ev',
      type,
      pricePerImpressionKrw: type === CampaignType.PAID ? price : 0,
      ...(rewardPolicyId ? { rewardPolicyId } : {}),
    });
    const cr = await admin(api().post(`/internal/v1/campaigns/${cam.body.id}/creatives`)).send({
      text: '광고 문구',
      brand: '브랜드',
      ...(landingUrl ? { landingUrl } : {}),
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
  async function getToken(accessToken: string, machineId: string, rehearsalMode?: 'TEST') {
    // 각 테스트는 서빙 풀을 좁히기 위해 직전에 만든 캠페인만 ACTIVE로 둔다.
    let response = api()
      .get('/v1/ad-decision')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-clawad-machine-id', machineId);
    if (rehearsalMode) response = response.set('x-clawad-rehearsal-mode', rehearsalMode);
    const res = await response.expect(200);
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

  const seedAccepted = async (userId: string, campaignId: string, count: number, dayOffset = 0) => {
    const receivedAt = new Date();
    receivedAt.setUTCDate(receivedAt.getUTCDate() + dayOffset);
    const prefix = randomUUID();
    await dataSource.query(
      `INSERT INTO impression_events
       ("idempotencyKey","tokenJti","campaignId","campaignType","userId","machineId","sequence",
        "startedAt","endedAt",decision,billed,"rewardEligible","companyFunded","receivedAt")
       SELECT $1 || '-idem-' || g, $1 || '-jti-' || g, $2, 'PAID', $3,
              '00000000000000000000000000000000', g,
              1000000 + g * 10000, 1005000 + g * 10000, 'ACCEPTED', false, true, false, $4
       FROM generate_series(1, $5::int) g`,
      [prefix, campaignId, userId, receivedAt.toISOString(), count],
    );
  };

  it('clientVersion은 안전한 semver 형식만 원장에 허용한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    const result = await postEvents(accessToken, machineId, [
      factEvent(token, machineId, 1, { clientVersion: '0.1.0\u0000sensitive' }),
    ]).expect(200);
    expect(result.body).toEqual({ received: 1, accepted: 0, rejected: { BAD_REQUEST: 1 } });
    expect(await dataSource.getRepository(ImpressionEvent).count({ where: { tokenJti: decodeJti(token) } })).toBe(0);

    const valid = await postEvents(accessToken, machineId, [
      factEvent(token, machineId, 1, { clientVersion: '1.2.3-beta.1+build.5' }),
    ]).expect(200);
    expect(valid.body).toEqual({ received: 1, accepted: 1, rejected: {} });
    const stored = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    expect(stored.clientVersion).toBe('1.2.3-beta.1+build.5');
  });

  const effectiveDecisions = async (userId: string) =>
    dataSource.query(
      `SELECT e."idempotencyKey", e."startedAt",
              COALESCE(t."toDecision"::text, e.decision::text) AS decision
       FROM impression_events e
       LEFT JOIN LATERAL (
         SELECT x.* FROM impression_decision_transitions x
         WHERE x."impressionEventId" = e.id ORDER BY x.id DESC LIMIT 1
       ) t ON true
       WHERE e."userId" = $1
       ORDER BY e."startedAt", e."idempotencyKey"`,
      [userId],
    ) as Promise<Array<{ idempotencyKey: string; startedAt: string; decision: ImpressionDecision }>>;

  it('토큰 없이 events 호출 시 401', async () => {
    await api().post('/v1/events').send([]).expect(401);
  });

  it('유효한 노출 1건을 인정하고 예산을 차감한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body).toEqual({ received: 1, accepted: 1, rejected: {} });

    const budget = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(budget.body.availableKrw).toBe(100000 - 2);
  });

  it('토큰 발급 뒤 정책과 캠페인이 바뀌어도 발급 시점 스냅샷으로 판정·과금·리워드한다', async () => {
    const { campaignId } = await activeCampaign(CampaignType.PAID, 2);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    await dataSource.query(
      `UPDATE campaigns SET status = 'ENDED', type = 'HOUSE', "pricePerImpressionKrw" = 0, "rewardPolicyId" = 'changed-v2' WHERE id = $1`,
      [campaignId],
    );

    const previousPolicyFile = process.env.CLAWAD_POLICY_FILE;
    process.env.CLAWAD_POLICY_FILE = resolve(__dirname, 'fixtures', 'reward-policy-v2.json');
    try {
      const uploaded = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
      expect(uploaded.body).toEqual({ received: 1, accepted: 1, rejected: {} });

      const event = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ userId, campaignId });
      expect(event.policyVersion).toBe(1);
      expect(event.pricePerImpressionKrwSnapshot).toBe(2);
      expect(event.rewardPerThousandSnapshot).toBe(300);
      expect(event.minViewMsSnapshot).toBe(5000);
      expect(event.policySnapshotId).toBeTruthy();
      await expect(
        dataSource.query(`UPDATE decision_policy_snapshots SET "policyVersion" = 999 WHERE id = $1`, [
          event.policySnapshotId,
        ]),
      ).rejects.toThrow(/append-only/);

      const captures = await dataSource.query(
        `SELECT * FROM billing_ledger WHERE "idempotencyKey" = $1 AND "entryType" = 'CAPTURE'`,
        [event.idempotencyKey],
      );
      expect(Number(captures[0].amountKrw)).toBe(-2);
      expect(Number(captures[0].unitPriceKrw)).toBe(2);
      expect(captures[0].policySnapshotId).toBe(event.policySnapshotId);

      await admin(api().post('/internal/v1/rewards/run-accrual')).expect(200);
      const reward = await dataSource.getRepository(RewardLedgerEntry).findOneByOrFail({
        refIdempotencyKey: event.idempotencyKey,
        entryType: RewardEntryType.ACCRUE_PENDING,
      });
      expect(reward.points).toBe(0);
      expect(reward.rewardPerThousandSnapshot).toBe(300);
      expect(reward.policySnapshotId).toBe(event.policySnapshotId);
    } finally {
      if (previousPolicyFile === undefined) delete process.env.CLAWAD_POLICY_FILE;
      else process.env.CLAWAD_POLICY_FILE = previousPolicyFile;
    }
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

  it('다른 계정은 같은 machineId를 등록해도 serveToken을 제출할 수 없다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const owner = await makeUserWithMachine();
    const attacker = await makeUserWithMachine();
    const token = await getToken(owner.accessToken, owner.machineId);
    const event = factEvent(token, owner.machineId, 1);

    // 같은 machineId가 다른 계정에도 존재하는 것은 위험 신호일 뿐 자동 차단하지 않는다.
    await api()
      .post('/v1/machines')
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .send({ machineId: owner.machineId })
      .expect(200);

    const rejected = await postEvents(attacker.accessToken, owner.machineId, [event]).expect(200);
    expect(rejected.body).toEqual({ received: 1, accepted: 0, rejected: { TOKEN_USER_MISMATCH: 1 } });

    const jti = decodeJti(token);
    expect(await dataSource.getRepository(ImpressionEvent).countBy({ tokenJti: jti })).toBe(0);
    const unchanged = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(unchanged.body.availableKrw).toBe(100000);

    // 공격자의 제출이 정상 사용자의 멱등 키를 선점하거나 토큰을 소비하지 않는다.
    const accepted = await postEvents(owner.accessToken, owner.machineId, [event]).expect(200);
    expect(accepted.body.accepted).toBe(1);
    const charged = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(charged.body.availableKrw).toBe(100000 - 2);
  });

  it('토큰 발급 후 해제된 머신의 노출은 MACHINE_NOT_ACTIVE로 거절한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const owner = await makeUserWithMachine();
    const token = await getToken(owner.accessToken, owner.machineId);

    await dataSource
      .getRepository(Machine)
      .update({ userId: owner.userId, machineId: owner.machineId }, { status: MachineStatus.RELEASED });

    const res = await postEvents(owner.accessToken, owner.machineId, [
      factEvent(token, owner.machineId, 1),
    ]).expect(200);
    expect(res.body).toEqual({ received: 1, accepted: 0, rejected: { MACHINE_NOT_ACTIVE: 1 } });

    const row = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    expect(row.decision).toBe(ImpressionDecision.REJECTED);
    expect(row.reason).toBe('MACHINE_NOT_ACTIVE');
    const budget = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(budget.body.availableKrw).toBe(100000);
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

  it('새 토큰으로 순번을 역행하면 SEQUENCE_ANOMALY', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();

    const firstToken = await getToken(accessToken, machineId);
    const rewindToken = await getToken(accessToken, machineId);
    await postEvents(accessToken, machineId, [factEvent(firstToken, machineId, 10)]).expect(200);

    const res = await postEvents(accessToken, machineId, [factEvent(rewindToken, machineId, 9)]).expect(200);
    expect(res.body).toEqual({ received: 1, accepted: 0, rejected: { SEQUENCE_ANOMALY: 1 } });
  });

  it('토큰 발급 시점보다 과거로 백데이트하면 BAD_INTERVAL', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);
    const startedAt = Date.now() - POLICY.impression.timeWindowToleranceMs - MIN_VIEW - 1000;

    const res = await postEvents(accessToken, machineId, [
      factEvent(token, machineId, 1, { startedAt, endedAt: startedAt + MIN_VIEW }),
    ]).expect(200);
    expect(res.body).toEqual({ received: 1, accepted: 0, rejected: { BAD_INTERVAL: 1 } });
  });

  it('24시간 연속 노출 패턴은 ABNORMAL_CONTINUOUS', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    const candidateStart = Date.now();
    const step = POLICY.abuse.continuousSessionMaxGapMs;
    const count = Math.floor(POLICY.abuse.maxContinuousSessionMs / step);
    const prefix = randomUUID();
    await dataSource.query(
      `INSERT INTO impression_events
       ("idempotencyKey","tokenJti","campaignId","campaignType","userId","machineId","sequence",
        "startedAt","endedAt",decision,billed,"rewardEligible","companyFunded","receivedAt")
       SELECT $1 || '-continuous-' || g, $1 || '-jti-' || g, $2, 'PAID', $3, $4, g + 1,
              $5::bigint - $6::bigint + g::bigint * $7::bigint,
              $5::bigint - $6::bigint + g::bigint * $7::bigint + $8::bigint,
              'ACCEPTED', false, true, false, now()
       FROM generate_series(0, $9::int - 1) g`,
      [prefix, campaignId, userId, machineId, candidateStart, POLICY.abuse.maxContinuousSessionMs, step, MIN_VIEW, count],
    );

    const token = await getToken(accessToken, machineId);
    const res = await postEvents(accessToken, machineId, [
      factEvent(token, machineId, count + 1, {
        startedAt: candidateStart,
        endedAt: candidateStart + MIN_VIEW,
      }),
    ]).expect(200);
    expect(res.body).toEqual({ received: 1, accepted: 0, rejected: { ABNORMAL_CONTINUOUS: 1 } });
  });

  it('백그라운드 표시는 신뢰 가능한 신호가 아니므로 단독 거절하지 않는다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    const res = await postEvents(accessToken, machineId, [
      factEvent(token, machineId, 1, { background: true }),
    ]).expect(200);
    expect(res.body).toEqual({ received: 1, accepted: 1, rejected: {} });
  });

  it('같은 가명 machineId의 다계정은 자동 부정 처리하지 않는다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const sharedMachineId = newMachineId();
    const first = await seedUser(app);
    const second = await seedUser(app);
    for (const user of [first, second]) {
      await api()
        .post('/v1/machines')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ machineId: sharedMachineId })
        .expect(200);
    }

    const firstToken = await getToken(first.accessToken, sharedMachineId);
    const secondToken = await getToken(second.accessToken, sharedMachineId);
    const firstResult = await postEvents(first.accessToken, sharedMachineId, [
      factEvent(firstToken, sharedMachineId, 1),
    ]).expect(200);
    const secondResult = await postEvents(second.accessToken, sharedMachineId, [
      factEvent(secondToken, sharedMachineId, 1),
    ]).expect(200);
    expect(firstResult.body.accepted).toBe(1);
    expect(secondResult.body.accepted).toBe(1);
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
    const { accessToken, userId, machineId } = await makeUserWithMachine();
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
    const { accessToken, userId, machineId } = await makeUserWithMachine();
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
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const projected = await effectiveDecisions(userId);
    expect(projected.filter((row) => row.decision === ImpressionDecision.ACCEPTED)).toHaveLength(1);
  });

  it('지연 업로드 순서와 무관하게 같은 최종 판정과 과금을 만든다', async () => {
    const run = async (lateFirst: boolean) => {
      const { campaignId } = await activeCampaign();
      await onlyThisCampaignActive(campaignId);
      const { accessToken, userId, machineId } = await makeUserWithMachine();
      const m2 = newMachineId();
      await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: m2 }).expect(200);
      const earlyToken = await getToken(accessToken, machineId);
      const lateToken = await getToken(accessToken, m2);
      const base = Date.now();
      const early = factEvent(earlyToken, machineId, 1, { startedAt: base, endedAt: base + MIN_VIEW + 500 });
      const late = factEvent(lateToken, m2, 2, { startedAt: base + 3000, endedAt: base + MIN_VIEW + 3500 });
      const ordered = lateFirst
        ? [[m2, late], [machineId, early]] as const
        : [[machineId, early], [m2, late]] as const;
      for (const [targetMachine, event] of ordered) {
        await postEvents(accessToken, targetMachine, [event]).expect(200);
      }

      const decisions = (await effectiveDecisions(userId)).map((row) => row.decision);
      const budget = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
      return { decisions, availableKrw: budget.body.availableKrw as number };
    };

    const forward = await run(false);
    const delayed = await run(true);
    expect(forward).toEqual({
      decisions: [ImpressionDecision.ACCEPTED, ImpressionDecision.REJECTED],
      availableKrw: 99998,
    });
    expect(delayed).toEqual(forward);
  });

  it('연쇄 겹침은 전체 체인을 재투영해 양 끝만 승인한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    const machines = [machineId, newMachineId(), newMachineId()];
    for (const machine of machines.slice(1)) {
      await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: machine }).expect(200);
    }
    const tokens = await Promise.all(machines.map((machine) => getToken(accessToken, machine)));
    const base = Date.now();
    const events = [
      factEvent(tokens[0], machines[0], 1, { startedAt: base, endedAt: base + 5000 }),
      factEvent(tokens[1], machines[1], 2, { startedAt: base + 4000, endedAt: base + 9000 }),
      factEvent(tokens[2], machines[2], 3, { startedAt: base + 8000, endedAt: base + 13000 }),
    ];
    for (const index of [2, 1, 0]) {
      await postEvents(accessToken, machines[index], [events[index]]).expect(200);
    }

    expect((await effectiveDecisions(userId)).map((row) => row.decision)).toEqual([
      ImpressionDecision.ACCEPTED,
      ImpressionDecision.REJECTED,
      ImpressionDecision.ACCEPTED,
    ]);
    const budget = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(budget.body.availableKrw).toBe(99996);
  });

  it('동률 시작 시각은 idempotency key 사전순으로 최종 승자를 정한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    const m2 = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: m2 }).expect(200);
    const tokens = [await getToken(accessToken, machineId), await getToken(accessToken, m2)];
    const startedAt = Date.now();
    await postEvents(accessToken, machineId, [
      factEvent(tokens[0], machineId, 1, { startedAt, endedAt: startedAt + MIN_VIEW + 500 }),
    ]).expect(200);
    await postEvents(accessToken, m2, [
      factEvent(tokens[1], m2, 2, { startedAt, endedAt: startedAt + MIN_VIEW + 500 }),
    ]).expect(200);

    const rows = await effectiveDecisions(userId);
    expect(rows[0].idempotencyKey < rows[1].idempotencyKey).toBe(true);
    expect(rows.map((row) => row.decision)).toEqual([
      ImpressionDecision.ACCEPTED,
      ImpressionDecision.REJECTED,
    ]);
  });

  it('이미 확정된 리워드는 승자 변경 시 append-only 조정으로 상쇄한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    const m2 = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: m2 }).expect(200);
    const earlyToken = await getToken(accessToken, machineId);
    const lateToken = await getToken(accessToken, m2);
    const base = Date.now();
    await postEvents(accessToken, m2, [
      factEvent(lateToken, m2, 2, { startedAt: base + 3000, endedAt: base + MIN_VIEW + 3500 }),
    ]).expect(200);
    const lateEvent = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(lateToken) });
    const rewardRepo = dataSource.getRepository(RewardLedgerEntry);
    await rewardRepo.save([
      rewardRepo.create({
        userId,
        entryType: RewardEntryType.ACCRUE_PENDING,
        points: 10,
        refIdempotencyKey: lateEvent.idempotencyKey,
      }),
      rewardRepo.create({
        userId,
        entryType: RewardEntryType.ACCRUE_CONFIRM,
        points: 10,
        refIdempotencyKey: lateEvent.idempotencyKey,
      }),
    ]);

    await postEvents(accessToken, machineId, [
      factEvent(earlyToken, machineId, 1, { startedAt: base, endedAt: base + MIN_VIEW + 500 }),
    ]).expect(200);
    const adjustment = await rewardRepo.findOneByOrFail({
      userId,
      entryType: RewardEntryType.REPROJECTION_ADJUST,
    });
    expect(adjustment.points).toBe(-10);
    expect(adjustment.reason).toBe('CONCURRENT_REPROJECTION_CONFIRMED');
  });

  it('광고주 상한 직전 동시 요청도 PostgreSQL 계정 잠금에서 한 건만 승인한다', async () => {
    const { campaignId } = await activeCampaign(CampaignType.PAID, 2, 100000, 1);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    const m2 = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: m2 }).expect(200);
    const tokens = [await getToken(accessToken, machineId), await getToken(accessToken, m2)];
    const base = Date.now();
    const [first, second] = await Promise.all([
      postEvents(accessToken, machineId, [
        factEvent(tokens[0], machineId, 1, { startedAt: base, endedAt: base + MIN_VIEW + 500 }),
      ]),
      postEvents(accessToken, m2, [
        factEvent(tokens[1], m2, 2, { startedAt: base + 10000, endedAt: base + MIN_VIEW + 10500 }),
      ]),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.accepted + second.body.accepted).toBe(1);
    expect((first.body.rejected.OVER_CAP ?? 0) + (second.body.rejected.OVER_CAP ?? 0)).toBe(1);
    expect((await effectiveDecisions(userId)).filter((row) => row.decision === ImpressionDecision.ACCEPTED)).toHaveLength(1);
  });

  it('상한에 도달해도 동시 노출 승자 교체는 순증이 없으면 허용한다', async () => {
    const { campaignId } = await activeCampaign(CampaignType.PAID, 2, 100000, 1);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    const m2 = newMachineId();
    await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId: m2 }).expect(200);
    const earlyToken = await getToken(accessToken, machineId);
    const lateToken = await getToken(accessToken, m2);
    const base = Date.now();
    await postEvents(accessToken, m2, [
      factEvent(lateToken, m2, 2, { startedAt: base + 3000, endedAt: base + MIN_VIEW + 3500 }),
    ]).expect(200);
    const replacement = await postEvents(accessToken, machineId, [
      factEvent(earlyToken, machineId, 1, { startedAt: base, endedAt: base + MIN_VIEW + 500 }),
    ]).expect(200);

    expect(replacement.body.accepted).toBe(1);
    expect((await effectiveDecisions(userId)).map((row) => row.decision)).toEqual([
      ImpressionDecision.ACCEPTED,
      ImpressionDecision.REJECTED,
    ]);
  });

  it('Redis flush 후에도 PostgreSQL 원장이 광고주 상한을 유지한다', async () => {
    const { campaignId } = await activeCampaign(CampaignType.PAID, 2, 100000, 1);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const firstToken = await getToken(accessToken, machineId);
    const base = Date.now();
    await postEvents(accessToken, machineId, [
      factEvent(firstToken, machineId, 1, { startedAt: base, endedAt: base + MIN_VIEW + 500 }),
    ]).expect(200);

    await redis.flushdb();
    const secondToken = await getToken(accessToken, machineId);
    const rejected = await postEvents(accessToken, machineId, [
      factEvent(secondToken, machineId, 2, { startedAt: base + 10000, endedAt: base + MIN_VIEW + 10500 }),
    ]).expect(200);
    expect(rejected.body).toEqual({ received: 1, accepted: 0, rejected: { OVER_CAP: 1 } });
    const budget = await admin(api().get(`/internal/v1/campaigns/${campaignId}/budget`)).expect(200);
    expect(budget.body.availableKrw).toBe(99998);
  });

  it('캠페인 일일 상한은 Redis 카운터가 없어도 PostgreSQL 원장 기준으로 거절한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    await seedAccepted(userId, campaignId, POLICY.frequency.perCampaignDailyImpressionLimit);
    await redis.flushdb();
    const token = await getToken(accessToken, machineId);
    const rejected = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(rejected.body.rejected.OVER_CAP).toBe(1);
  });

  it('계정 일일 상한은 UTC 수신일 경계로 계산한다', async () => {
    const seedCampaign = await activeCampaign();
    const candidateCampaign = await activeCampaign();
    await onlyThisCampaignActive(candidateCampaign.campaignId);

    const capped = await makeUserWithMachine();
    await seedAccepted(capped.userId, seedCampaign.campaignId, POLICY.reward.dailyAcceptedImpressionLimit);
    const cappedToken = await getToken(capped.accessToken, capped.machineId);
    const rejected = await postEvents(capped.accessToken, capped.machineId, [
      factEvent(cappedToken, capped.machineId, 1),
    ]).expect(200);
    expect(rejected.body.rejected.OVER_CAP).toBe(1);

    const nextDay = await makeUserWithMachine();
    await seedAccepted(nextDay.userId, candidateCampaign.campaignId, POLICY.reward.dailyAcceptedImpressionLimit, -1);
    await redis.flushdb();
    const nextDayToken = await getToken(nextDay.accessToken, nextDay.machineId);
    const accepted = await postEvents(nextDay.accessToken, nextDay.machineId, [
      factEvent(nextDayToken, nextDay.machineId, 1),
    ]).expect(200);
    expect(accepted.body.accepted).toBe(1);
  });

  it('헤드리스 무한 노출은 계정 일일 상한 경계에서 차단한다', async () => {
    const seedCampaign = await activeCampaign();
    const candidateCampaign = await activeCampaign();
    await onlyThisCampaignActive(candidateCampaign.campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();
    await seedAccepted(userId, seedCampaign.campaignId, POLICY.reward.dailyAcceptedImpressionLimit - 1);

    const boundaryToken = await getToken(accessToken, machineId);
    const overToken = await getToken(accessToken, machineId);
    const boundary = await postEvents(accessToken, machineId, [factEvent(boundaryToken, machineId, 1)]).expect(200);
    expect(boundary.body.accepted).toBe(1);

    const overStartedAt = Date.now() + MIN_VIEW + POLICY.impression.concurrentToleranceMs + 1000;
    const over = await postEvents(accessToken, machineId, [
      factEvent(overToken, machineId, 2, {
        startedAt: overStartedAt,
        endedAt: overStartedAt + MIN_VIEW,
      }),
    ]).expect(200);
    expect(over.body).toEqual({ received: 1, accepted: 0, rejected: { OVER_CAP: 1 } });
  });

  it('킬스위치에 걸린 캠페인의 노출은 KILLED', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    await admin(api().post('/internal/v1/kill-switch'))
      .send({ target: KillSwitchTarget.CAMPAIGN, targetId: campaignId, reasonCode: 'IVT_TEST' })
      .expect(201);

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body.rejected.KILLED).toBe(1);
  });

  it('사용자·머신·캠페인 킬스위치는 신규 광고 토큰 발급을 차단한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, userId, machineId } = await makeUserWithMachine();

    for (const [target, targetId] of [
      [KillSwitchTarget.USER, userId],
      [KillSwitchTarget.MACHINE, machineId],
      [KillSwitchTarget.CAMPAIGN, campaignId],
    ] as const) {
      await enableSwitch(target, targetId);
      try {
        const decision = await api()
          .get('/v1/ad-decision')
          .set('Authorization', `Bearer ${accessToken}`)
          .set('x-clawad-machine-id', machineId)
          .expect(404);
        expect(decision.body.error).toBe('NO_ELIGIBLE_AD');

        const status = await api()
          .get('/v1/ad-decision/prefetch-status')
          .set('Authorization', `Bearer ${accessToken}`)
          .set('x-clawad-machine-id', machineId)
          .set('x-clawad-campaign-ids', campaignId)
          .expect(200);
        if (target === KillSwitchTarget.CAMPAIGN) {
          expect(status.body.paused).toBe(false);
          expect(status.body.blockedCampaignIds).toContain(campaignId);
        } else {
          expect(status.body.paused).toBe(true);
          expect(status.body.needsRefill).toBe(false);
          expect(status.body.blockedCampaignIds).toEqual([]);
        }
      } finally {
        await disableSwitch(target, targetId);
      }
    }
  });

  it('전체 긴급 중지는 발급·클릭·신규 승인을 차단하고 원장에 KILLED만 append한다', async () => {
    const { campaignId } = await activeCampaign(CampaignType.PAID, 2, 100000, undefined, 'https://example.com');
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const decision = await api()
      .get('/v1/ad-decision')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-clawad-machine-id', machineId)
      .expect(200);
    const token = decision.body.serveToken as string;
    expect(decision.body.clickUrl).toBeTruthy();

    await admin(api().post('/internal/v1/emergency-stop'))
      .send({ reasonCode: 'ALPHA_INCIDENT_TEST', incidentRef: 'CLAW-65' })
      .expect(201);
    try {
      const activeSwitches = await admin(api().get('/internal/v1/kill-switches')).expect(200);
      expect(
        activeSwitches.body.filter((row: { target: KillSwitchTarget }) =>
          [KillSwitchTarget.GLOBAL_ADS, KillSwitchTarget.GLOBAL_REWARDS].includes(row.target),
        ),
      ).toHaveLength(2);
      const status = await api()
        .get('/v1/ad-decision/prefetch-status')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('x-clawad-machine-id', machineId)
        .expect(200);
      expect(status.body).toMatchObject({ paused: true, needsRefill: false, unused: 0 });

      await api()
        .get('/v1/ad-decision')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('x-clawad-machine-id', machineId)
        .expect(404);

      const clickPath = new URL(decision.body.clickUrl as string).pathname;
      const click = await api().get(clickPath).expect(409);
      expect(click.body.error).toBe('CLICK_DISABLED');

      const malformed = await postEvents(accessToken, machineId, [
        factEvent(token, machineId, 2, { endedAt: Number.MAX_VALUE }),
      ]).expect(200);
      expect(malformed.body).toEqual({ received: 1, accepted: 0, rejected: { BAD_REQUEST: 1 } });

      const uploaded = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
      expect(uploaded.body).toEqual({ received: 1, accepted: 0, rejected: { KILLED: 1 } });
      const event = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
      expect(event.decision).toBe(ImpressionDecision.REJECTED);
      expect(event.reason).toBe('KILLED');
      expect(event.billed).toBe(false);
      expect(event.rewardEligible).toBe(false);
      expect(
        await dataSource.query(
          `SELECT 1 FROM billing_ledger WHERE "idempotencyKey" = $1 AND "entryType" = 'CAPTURE'`,
          [event.idempotencyKey],
        ),
      ).toHaveLength(0);
      expect(
        await dataSource.getRepository(RewardLedgerEntry).count({ where: { refIdempotencyKey: event.idempotencyKey } }),
      ).toBe(0);
    } finally {
      await admin(api().post('/internal/v1/emergency-resume'))
        .send({ reasonCode: 'ALPHA_RECOVERY_TEST', incidentRef: 'CLAW-65' })
        .expect(200);
    }

    await api()
      .get('/v1/ad-decision')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-clawad-machine-id', machineId)
      .expect(200);
  });

  it('stop 활성 구간과 겹친 지연 업로드는 재개 뒤에도 KILLED이고 새 구간만 승인한다', async () => {
    const { campaignId } = await activeCampaign();
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);
    const issuedAt = decodePayload(token).issuedAt as number;

    await admin(api().post('/internal/v1/emergency-stop'))
      .send({ reasonCode: 'OFFLINE_INTERVAL_TEST', incidentRef: 'CLAW-65' })
      .expect(201);
    await admin(api().post('/internal/v1/emergency-resume'))
      .send({ reasonCode: 'OFFLINE_INTERVAL_RECOVERY', incidentRef: 'CLAW-65' })
      .expect(200);

    // 토큰 발급 뒤 시작했고 stop 시각을 가로지르는 표시 구간. 업로드 시점에는 resume됐어도
    // 과거 활성 구간과 겹치므로 append-only KILLED로 남아야 한다.
    const delayed = await postEvents(accessToken, machineId, [
      factEvent(token, machineId, 1, { startedAt: issuedAt, endedAt: issuedAt + MIN_VIEW + 500 }),
    ]).expect(200);
    expect(delayed.body).toEqual({ received: 1, accepted: 0, rejected: { KILLED: 1 } });
    const killed = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    expect(killed).toMatchObject({ decision: ImpressionDecision.REJECTED, reason: 'KILLED', billed: false });

    const resumedToken = await getToken(accessToken, machineId);
    const resumed = await postEvents(accessToken, machineId, [factEvent(resumedToken, machineId, 2)]).expect(200);
    expect(resumed.body.accepted).toBe(1);
  });

  it('동시 enable도 active 스위치 한 행으로 멱등 수렴한다', async () => {
    const targetId = randomUUID();
    await Promise.all(Array.from({ length: 8 }, () => enableSwitch(KillSwitchTarget.CAMPAIGN, targetId)));
    try {
      const [{ count }] = await dataSource.query(
        `SELECT COUNT(*)::int AS count FROM kill_switches
         WHERE target::text = $1 AND "targetId" = $2 AND active = true`,
        [KillSwitchTarget.CAMPAIGN, targetId],
      );
      expect(Number(count)).toBe(1);
    } finally {
      await disableSwitch(KillSwitchTarget.CAMPAIGN, targetId);
    }
  });

  it('전체 중지 응답은 진행 중인 광고 shared transaction이 drain된 뒤에만 반환된다', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const switches = app.get(KillSwitchService);
    await switches.acquireAdsShared(runner.manager);

    let stopSettled = false;
    const stopPromise = admin(api().post('/internal/v1/emergency-stop'))
      .send({ reasonCode: 'CONCURRENCY_TEST', incidentRef: 'CLAW-65' })
      .then((response) => {
        stopSettled = true;
        return response;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stopSettled).toBe(false);
      await runner.commitTransaction();
      const stopped = await stopPromise;
      expect(stopped.status).toBe(201);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      if (!stopSettled) await stopPromise;
      await admin(api().post('/internal/v1/emergency-resume'))
        .send({ reasonCode: 'CONCURRENCY_RECOVERY', incidentRef: 'CLAW-65' })
        .expect(200);
    }
  });

  it('BUDGET_EXHAUSTED: 예산이 소진되면 과금 없이 인정하고 회사 재원으로 표시한다', async () => {
    // 헤드룸(단가 × 미사용 토큰 상한)을 통과할 예산으로 토큰을 발급받은 뒤,
    // 노출 검증 전에 예산을 소진시킨다 — 사용자가 이미 광고를 본 상황을 재현.
    const headroom = 2 * POLICY.serveToken.maxUnusedTokensPerMachine;
    const { campaignId, advertiserId } = await activeCampaign(CampaignType.PAID, 2, headroom);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    // 예산을 0으로 드레인(CAPTURE 음수 append — append-only 허용).
    await dataSource.query(
      `INSERT INTO billing_ledger ("advertiserId","campaignId","entryType","amountKrw") VALUES ($1,$2,'CAPTURE',$3)`,
      [advertiserId, campaignId, -headroom],
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

  it('HOUSE opt-in은 광고주 과금 없이 회사 재원 리워드 자격을 기록한다', async () => {
    const { campaignId } = await activeCampaign(
      CampaignType.HOUSE,
      0,
      0,
      undefined,
      undefined,
      'house-promo-v1',
    );
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId);

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body.accepted).toBe(1);
    const row = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    expect(row.billed).toBe(false);
    expect(row.rewardEligible).toBe(true);
    expect(row.companyFunded).toBe(true);
    expect(row.rewardPolicyId).toBe('house-promo-v1');
  });

  it('TEST 리허설 노출은 인정되지만 광고주 매출·실제 리워드 부채를 만들지 않는다', async () => {
    const { campaignId } = await activeCampaign(CampaignType.TEST, 0, 0);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId, 'TEST');

    const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
    expect(res.body.accepted).toBe(1);
    const row = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
    expect(row).toMatchObject({ billed: false, rewardEligible: false, companyFunded: false });
    const billingRows = await dataSource.query(`SELECT id FROM billing_ledger WHERE "campaignId" = $1`, [campaignId]);
    expect(billingRows).toHaveLength(0);
    await admin(api().post('/internal/v1/rewards/run-accrual')).expect(200);
    expect(
      await dataSource.getRepository(RewardLedgerEntry).count({ where: { refIdempotencyKey: row.idempotencyKey } }),
    ).toBe(0);
  });

  it('리허설 게이트 종료 후에는 이미 발급된 TEST 토큰도 새 이벤트로 인정하지 않는다', async () => {
    const { campaignId } = await activeCampaign(CampaignType.TEST, 0, 0);
    await onlyThisCampaignActive(campaignId);
    const { accessToken, machineId } = await makeUserWithMachine();
    const token = await getToken(accessToken, machineId, 'TEST');

    process.env.CLAWAD_TEST_REHEARSAL_ENABLED = 'false';
    try {
      const res = await postEvents(accessToken, machineId, [factEvent(token, machineId, 1)]).expect(200);
      expect(res.body).toEqual({
        received: 1,
        accepted: 0,
        rejected: { TEST_REHEARSAL_DISABLED: 1 },
      });
    } finally {
      process.env.CLAWAD_TEST_REHEARSAL_ENABLED = 'true';
    }
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

  it('표시 당시 유효했던 토큰은 업로드 시점에 만료돼도 인정한다 (CLAW-102)', async () => {
    // sync는 주기 실행이라 표시와 업로드 사이에 수 분이 벌어진다. 수신 시각으로 만료를 재면
    // 표시 당시 유효했던 노출이 impression_events 행조차 남기지 못하고 사라진다.
    const previousPolicyFile = process.env.CLAWAD_POLICY_FILE;
    process.env.CLAWAD_POLICY_FILE = resolve(__dirname, 'fixtures', 'reward-policy-short-token.json');
    try {
      const { campaignId } = await activeCampaign(CampaignType.PAID, 2, 100000);
      await onlyThisCampaignActive(campaignId);
      const { accessToken, machineId } = await makeUserWithMachine();
      const token = await getToken(accessToken, machineId);

      // 발급 직후 정상 시청. 표시 구간은 토큰 수명(8초) 안에 있다.
      const event = factEvent(token, machineId, 1);

      // 업로드가 늦어져 토큰이 만료된 뒤 도착하는 상황.
      await new Promise((r) => setTimeout(r, 9000));

      const uploaded = await postEvents(accessToken, machineId, [event]).expect(200);
      expect(uploaded.body).toEqual({ received: 1, accepted: 1, rejected: {} });
      expect(uploaded.body.rejected).toEqual({});

      const row = await dataSource.getRepository(ImpressionEvent).findOneByOrFail({ tokenJti: decodeJti(token) });
      expect(row.decision).toBe(ImpressionDecision.ACCEPTED);
    } finally {
      if (previousPolicyFile === undefined) delete process.env.CLAWAD_POLICY_FILE;
      else process.env.CLAWAD_POLICY_FILE = previousPolicyFile;
    }
  }, 30000);

});

/** 서명 토큰 payload에서 jti를 꺼낸다(테스트 검증용). */
function decodeJti(serveToken: string): string {
  return decodePayload(serveToken).jti as string;
}

function decodePayload(serveToken: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(serveToken.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>;
}
