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
import { ImpressionDecision, ImpressionEvent } from '../src/entities/impression-event.entity';
import { RewardEntryType, RewardFunding, RewardLedgerEntry } from '../src/entities/reward-ledger.entity';

let adminToken: string;
const POLICY = loadPolicy();
const RATE = POLICY.reward.rewardPerThousandAcceptedImpressions; // 300
const DAILY_LIMIT = POLICY.reward.dailyRewardLimit; // 150

const newMachineId = () => randomBytes(16).toString('hex');
const newEmail = () => `rw-${randomUUID()}@example.test`;

describe('CLAW-5 리워드 원장·확정 배치 (e2e)', () => {
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

  async function makeUser() {
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
    return { accessToken: res.body.accessToken as string, userId: decodeSub(res.body.accessToken) };
  }

  /**
   * impression_events에 직접 ACCEPTED 노출을 심는다. CLAW-6 파이프라인을 거치지 않고
   * 리워드 배치 로직만 격리 검증하기 위함. (파이프라인 연동은 CLAW-6 e2e에서 검증됨)
   */
  async function seedImpressions(
    userId: string,
    count: number,
    opts: { rewardEligible?: boolean; companyFunded?: boolean; billed?: boolean; day?: string } = {},
  ) {
    const rewardEligible = opts.rewardEligible ?? true;
    const rows = [];
    for (let i = 0; i < count; i++) {
      const idem = randomBytes(32).toString('hex');
      const received = opts.day ? `${opts.day}T12:00:00Z` : new Date().toISOString();
      rows.push(
        dataSource.query(
          `INSERT INTO impression_events
           ("idempotencyKey","tokenJti","campaignId","campaignType","userId","machineId","sequence","startedAt","endedAt","decision","billed","rewardEligible","companyFunded","receivedAt")
           VALUES ($1,$2,$3,'PAID',$4,$5,$6,0,5000,'ACCEPTED',$7,$8,$9,$10)`,
          [
            idem,
            randomUUID(),
            randomUUID(),
            userId,
            newMachineId(),
            i + 1,
            opts.billed ?? true,
            rewardEligible,
            opts.companyFunded ?? false,
            received,
          ],
        ),
      );
    }
    await Promise.all(rows);
  }

  const runAccrual = () => admin(api().post('/internal/v1/rewards/run-accrual')).expect(200);
  const runConfirm = () => admin(api().post('/internal/v1/rewards/run-confirmation')).expect(200);
  const rewardsOf = (accessToken: string) =>
    api().get('/v1/rewards').set('Authorization', `Bearer ${accessToken}`).expect(200);

  it('토큰 없이 rewards 조회 시 401', async () => {
    await api().get('/v1/rewards').expect(401);
  });

  it('인정 노출을 정책 단가로 적립한다 (검증 중)', async () => {
    const { accessToken, userId } = await makeUser();
    await seedImpressions(userId, 10); // 10 × 300/1000 = 3P

    await runAccrual();
    const res = await rewardsOf(accessToken);
    expect(res.body.verifyingPoints).toBe(Math.floor((10 * RATE) / 1000));
    expect(res.body.confirmedPoints).toBe(0);
  });

  it('정수 반올림 오차를 캐리로 흡수한다 — 합계가 floor(n·rate/1000)', async () => {
    const { accessToken, userId } = await makeUser();
    await seedImpressions(userId, 7); // 7×300/1000 = 2.1 → floor 2P (노출별 0.3씩 캐리)

    await runAccrual();
    const res = await rewardsOf(accessToken);
    expect(res.body.verifyingPoints).toBe(Math.floor((7 * RATE) / 1000)); // 2

    // 노출별 행 points 합이 정확히 2
    const rows = await dataSource.getRepository(RewardLedgerEntry).find({ where: { userId } });
    const sum = rows.reduce((a, r) => a + r.points, 0);
    expect(sum).toBe(2);
    expect(rows).toHaveLength(7); // 노출 1건당 1행
  });

  it('적립 배치는 멱등이다 — 두 번 돌려도 중복 적립 없음', async () => {
    const { accessToken, userId } = await makeUser();
    await seedImpressions(userId, 20);

    await runAccrual();
    await runAccrual(); // 재실행
    const res = await rewardsOf(accessToken);
    expect(res.body.verifyingPoints).toBe(Math.floor((20 * RATE) / 1000)); // 6
    const rows = await dataSource.getRepository(RewardLedgerEntry).count({ where: { userId } });
    expect(rows).toBe(20); // 중복 행 없음
  });

  it('일일 적립 상한을 넘지 않는다 (정책값)', async () => {
    const { accessToken, userId } = await makeUser();
    // 상한 도달 노출 수보다 많이 심는다: dailyLimit=150P면 500노출에서 도달.
    const overCount = Math.ceil((DAILY_LIMIT * 1000) / RATE) + 50;
    await seedImpressions(userId, overCount, { day: '2026-06-01' });

    await runAccrual();
    const res = await rewardsOf(accessToken);
    expect(res.body.verifyingPoints).toBe(DAILY_LIMIT); // 상한에서 멈춤
  });

  it('확정 배치가 검증 중 → 확정으로 옮긴다', async () => {
    const { accessToken, userId } = await makeUser();
    await seedImpressions(userId, 10);
    await runAccrual();

    let res = await rewardsOf(accessToken);
    expect(res.body.verifyingPoints).toBe(3);
    expect(res.body.confirmedPoints).toBe(0);

    await runConfirm();
    res = await rewardsOf(accessToken);
    expect(res.body.verifyingPoints).toBe(0); // 더 이상 검증 중 아님
    expect(res.body.confirmedPoints).toBe(3); // 확정
  });

  it('rewardEligible=false 노출은 적립하지 않는다 (HOUSE 기본·TEST)', async () => {
    const { accessToken, userId } = await makeUser();
    await seedImpressions(userId, 10, { rewardEligible: false });
    await runAccrual();
    const res = await rewardsOf(accessToken);
    expect(res.body.verifyingPoints).toBe(0);
  });

  it('BUDGET_EXHAUSTED(회사 재원) 노출은 funding=COMPANY로 적립한다', async () => {
    const { userId } = await makeUser();
    await seedImpressions(userId, 10, { companyFunded: true, billed: false });
    await runAccrual();
    const rows = await dataSource.getRepository(RewardLedgerEntry).find({ where: { userId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.funding === RewardFunding.COMPANY)).toBe(true);
  });

  it('회수: claw_back으로 리워드를 되돌리고 확정 잔액이 줄어든다', async () => {
    const { accessToken, userId } = await makeUser();
    await seedImpressions(userId, 10);
    await runAccrual();
    await runConfirm();
    expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(3);

    // 노출 하나를 회수 대상으로 지목(전체 적립을 되돌리려면 여러 건 필요하지만, 여기선 부분 회수 확인).
    const target = await dataSource
      .getRepository(RewardLedgerEntry)
      .findOneOrFail({ where: { userId, entryType: RewardEntryType.ACCRUE_PENDING }, order: { points: 'DESC' } });

    const res = await admin(api().post('/internal/v1/rewards/claw-back'))
      .send({ idempotencyKey: target.refIdempotencyKey, reason: 'IVT_TEST' })
      .expect(200);
    expect(res.body.clawedPoints).toBeGreaterThanOrEqual(0);

    // 회수 후 확정 잔액은 회수 포인트만큼 감소
    const after = (await rewardsOf(accessToken)).body.confirmedPoints;
    expect(after).toBe(3 - res.body.clawedPoints);
  });

  it('회수 시 광고주 크레딧을 복원한다 (billed 노출)', async () => {
    const { userId } = await makeUser();
    // 캠페인·예산을 실제로 만들어 billed 노출과 연결한다.
    const adv = await admin(api().post('/internal/v1/advertisers')).send({ name: `rw-${randomUUID().slice(0, 8)}` });
    const cam = await admin(api().post('/internal/v1/campaigns')).send({
      advertiserId: adv.body.id,
      name: 'rw',
      type: CampaignType.PAID,
      pricePerImpressionKrw: 2,
    });
    await admin(api().post(`/internal/v1/campaigns/${cam.body.id}/budget/credit`))
      .send({ entryType: BillingEntryType.DEPOSIT, amountKrw: 1000 })
      .expect(201);

    const idem = randomBytes(32).toString('hex');
    await dataSource.query(
      `INSERT INTO impression_events
       ("idempotencyKey","tokenJti","campaignId","campaignType","userId","machineId","sequence","startedAt","endedAt","decision","billed","rewardEligible","companyFunded","receivedAt")
       VALUES ($1,$2,$3,'PAID',$4,$5,1,0,5000,'ACCEPTED',true,true,false,now())`,
      [idem, randomUUID(), cam.body.id, userId, newMachineId()],
    );
    // 과금도 반영(capture -2)
    await dataSource.query(
      `INSERT INTO billing_ledger ("advertiserId","campaignId","entryType","amountKrw","idempotencyKey") VALUES ($1,$2,'CAPTURE',-2,$3)`,
      [adv.body.id, cam.body.id, idem],
    );

    const before = await admin(api().get(`/internal/v1/campaigns/${cam.body.id}/budget`)).expect(200);
    expect(before.body.availableKrw).toBe(998);

    const res = await admin(api().post('/internal/v1/rewards/claw-back'))
      .send({ idempotencyKey: idem, reason: 'IVT' })
      .expect(200);
    expect(res.body.refunded).toBe(true);

    const after = await admin(api().get(`/internal/v1/campaigns/${cam.body.id}/budget`)).expect(200);
    expect(after.body.availableKrw).toBe(1000); // 복원됨
  });

  it('claw-back을 두 번 호출해도 광고주 예산이 이중 복원되지 않는다 (멱등)', async () => {
    const { userId } = await makeUser();
    const adv = await admin(api().post('/internal/v1/advertisers')).send({ name: `rw-${randomUUID().slice(0, 8)}` });
    const cam = await admin(api().post('/internal/v1/campaigns')).send({
      advertiserId: adv.body.id,
      name: 'rw2',
      type: CampaignType.PAID,
      pricePerImpressionKrw: 2,
    });
    await admin(api().post(`/internal/v1/campaigns/${cam.body.id}/budget/credit`))
      .send({ entryType: BillingEntryType.DEPOSIT, amountKrw: 1000 })
      .expect(201);

    const idem = randomBytes(32).toString('hex');
    await dataSource.query(
      `INSERT INTO impression_events
       ("idempotencyKey","tokenJti","campaignId","campaignType","userId","machineId","sequence","startedAt","endedAt","decision","billed","rewardEligible","companyFunded","receivedAt")
       VALUES ($1,$2,$3,'PAID',$4,$5,1,0,5000,'ACCEPTED',true,true,false,now())`,
      [idem, randomUUID(), cam.body.id, userId, newMachineId()],
    );
    await dataSource.query(
      `INSERT INTO billing_ledger ("advertiserId","campaignId","entryType","amountKrw","idempotencyKey") VALUES ($1,$2,'CAPTURE',-2,$3)`,
      [adv.body.id, cam.body.id, idem],
    );

    const clawBack = () =>
      admin(api().post('/internal/v1/rewards/claw-back')).send({ idempotencyKey: idem, reason: 'IVT' }).expect(200);

    await clawBack();
    await clawBack(); // 두 번째 호출

    const budget = await admin(api().get(`/internal/v1/campaigns/${cam.body.id}/budget`)).expect(200);
    expect(budget.body.availableKrw).toBe(1000); // 998 + 2(복원) — 이중 복원되면 1002가 됨
  });

  it('확정 전에 회수하면 확정 잔액이 음수로 가지 않는다', async () => {
    const { accessToken, userId } = await makeUser();
    await seedImpressions(userId, 10);
    await runAccrual(); // pending 3P, 아직 확정 안 함

    // 확정 전에 적립분을 전부 회수한다.
    const pendings = await dataSource
      .getRepository(RewardLedgerEntry)
      .find({ where: { userId, entryType: RewardEntryType.ACCRUE_PENDING } });
    for (const p of pendings.filter((r) => r.points > 0)) {
      await admin(api().post('/internal/v1/rewards/claw-back'))
        .send({ idempotencyKey: p.refIdempotencyKey, reason: 'IVT' })
        .expect(200);
    }

    const res = await rewardsOf(accessToken);
    expect(res.body.confirmedPoints).toBe(0); // 음수 아님
    expect(res.body.verifyingPoints).toBe(0); // 회수되어 검증 중도 아님

    // 이후 확정 배치를 돌려도 회수된 건은 확정되지 않는다.
    await runConfirm();
    expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(0);
  });

  it('원장은 append-only — DB가 UPDATE·DELETE를 거부한다', async () => {
    const { userId } = await makeUser();
    await seedImpressions(userId, 5);
    await runAccrual();
    const row = await dataSource.getRepository(RewardLedgerEntry).findOneByOrFail({ userId });
    await expect(
      dataSource.query(`UPDATE reward_ledger SET points=999 WHERE id=$1`, [row.id]),
    ).rejects.toThrow(/append-only/);
    await expect(dataSource.query(`DELETE FROM reward_ledger WHERE id=$1`, [row.id])).rejects.toThrow(/append-only/);
  });

  it('리워드 원장에 세율·과세 컬럼이 없다 (CLAW-13 미확정)', async () => {
    const cols = await dataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='reward_ledger' AND (column_name ILIKE '%tax%' OR column_name ILIKE '%withhold%' OR column_name ILIKE '%rate%')`,
    );
    expect(cols).toHaveLength(0);
  });
});

function decodeSub(jwt: string): string {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  return payload.sub;
}
