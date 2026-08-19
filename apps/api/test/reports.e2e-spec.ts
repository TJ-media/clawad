import './setup-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { loadPolicy } from '../src/common/policy';
import { RewardEntryType, RewardFunding, RewardLedgerEntry } from '../src/entities/reward-ledger.entity';
import { Report } from '../src/reports/report.entity';
import { loginAsRole, loginBootstrapAdmin } from './admin-helper';
import { AdminRole } from '../src/admin/admin-user.entity';
import { seedUser } from './social-helper';

const LIMITS = loadPolicy().bugReport;

describe('CLAW-234 이용자 제보·답변·포상 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let settler: string;
  let reviewer: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    const superToken = await loginBootstrapAdmin(app);
    settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
    reviewer = await loginAsRole(app, superToken, AdminRole.REVIEWER);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const auth = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  const submit = (token: string, body: unknown) => auth(api().post('/v1/reports'), token).send(body as object);

  it('미인증 제출은 401이다 — 익명 제보를 열지 않는다', async () => {
    await api().post('/v1/reports').send({ body: '버그가 있어요' }).expect(401);
    await api().get('/v1/reports').expect(401);
  });

  it('제출하면 목록에 남고 안 읽은 답변은 0이다', async () => {
    const user = await seedUser(app);
    const created = await submit(user.accessToken, { body: '광고가 두 번 겹쳐 보입니다' }).expect(201);
    expect(created.body.reportId).toBeDefined();

    const list = await auth(api().get('/v1/reports'), user.accessToken).expect(200);
    expect(list.body.reports).toHaveLength(1);
    expect(list.body.reports[0].status).toBe('OPEN');
    expect(list.body.reports[0].reply).toBeNull();
    // 답변이 없으면 읽을 것도 없다.
    expect(list.body.unread).toBe(0);
  });

  it('빈 본문과 상한 초과 본문은 400이다', async () => {
    const user = await seedUser(app);
    await submit(user.accessToken, { body: '   ' }).expect(400);
    const tooLong = await submit(user.accessToken, { body: 'ㄱ'.repeat(LIMITS.maxBodyLength + 1) }).expect(400);
    expect(tooLong.body.error).toBe('BODY_TOO_LONG');
  });

  it('이메일을 넣으면 동의가 필요하고, 동의하면 저장된다', async () => {
    const user = await seedUser(app);
    const noConsent = await submit(user.accessToken, {
      body: '답변 주세요', replyEmail: 'tester@example.com',
    }).expect(400);
    expect(noConsent.body.error).toBe('EMAIL_CONSENT_REQUIRED');

    const created = await submit(user.accessToken, {
      body: '답변 주세요', replyEmail: 'tester@example.com', replyEmailConsent: true,
    }).expect(201);

    const row = await dataSource.getRepository(Report).findOneOrFail({ where: { id: created.body.reportId } });
    expect(row.replyEmail).toBe('tester@example.com');
    expect(row.replyEmailConsentAt).not.toBeNull();
  });

  it('계정당 하루 제출 상한을 넘으면 409다', async () => {
    const user = await seedUser(app);
    for (let i = 0; i < LIMITS.dailySubmitLimit; i += 1) {
      await submit(user.accessToken, { body: `제보 ${i}` }).expect(201);
    }
    const over = await submit(user.accessToken, { body: '한 건 더' }).expect(409);
    expect(over.body.error).toBe('DAILY_SUBMIT_LIMIT_EXCEEDED');
  });

  it('운영자가 답변하면서 포상하면 원장에 PROMO_ACCRUE로 적립되고 이메일이 파기된다', async () => {
    const user = await seedUser(app);
    const created = await submit(user.accessToken, {
      body: '재현 절차를 적습니다', replyEmail: 'tester@example.com', replyEmailConsent: true,
    }).expect(201);
    const reportId = created.body.reportId;

    const replied = await auth(api().post(`/internal/v1/reports/${reportId}/reply`), settler)
      .send({ reply: '확인했습니다. 다음 릴리스에 반영합니다.', rewardPoints: 700 })
      .expect(200);
    expect(replied.body.rewardedPoints).toBe(700);
    expect(replied.body.balancePoints).toBe(700);

    const entries = await dataSource.getRepository(RewardLedgerEntry).find({
      where: { refIdempotencyKey: `report:${reportId}` },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe(RewardEntryType.PROMO_ACCRUE);
    // 광고주 매출과 무관한 회사 재원이다 (rules §5).
    expect(entries[0].funding).toBe(RewardFunding.COMPANY);
    expect(entries[0].points).toBe(700);

    // 답변으로 목적을 달성했으므로 이메일은 파기하고 동의 시각만 남긴다 (CLAW-233).
    const row = await dataSource.getRepository(Report).findOneOrFail({ where: { id: reportId } });
    expect(row.replyEmail).toBeNull();
    expect(row.replyEmailConsentAt).not.toBeNull();
    expect(row.status).toBe('ANSWERED');
  });

  it('포상 없이 답변만 할 수 있다 — 포상은 선택이다', async () => {
    const user = await seedUser(app);
    const created = await submit(user.accessToken, { body: '오타를 발견했어요' }).expect(201);
    const replied = await auth(api().post(`/internal/v1/reports/${created.body.reportId}/reply`), settler)
      .send({ reply: '고쳤습니다. 감사합니다.' })
      .expect(200);
    expect(replied.body.rewardedPoints).toBe(0);

    const entries = await dataSource.getRepository(RewardLedgerEntry).find({
      where: { refIdempotencyKey: `report:${created.body.reportId}` },
    });
    expect(entries).toHaveLength(0);
  });

  it('포상 상한을 넘기면 400이다 — 오타 한 번이 원장에 들어가지 않게 막는다', async () => {
    const user = await seedUser(app);
    const created = await submit(user.accessToken, { body: '상한 확인' }).expect(201);
    const over = await auth(api().post(`/internal/v1/reports/${created.body.reportId}/reply`), settler)
      .send({ reply: '답변', rewardPoints: LIMITS.maxRewardPoints + 1 })
      .expect(400);
    expect(over.body.error).toBe('REWARD_POINTS_EXCEEDS_LIMIT');
  });

  it('같은 제보에 두 번 답변하지 않는다', async () => {
    const user = await seedUser(app);
    const created = await submit(user.accessToken, { body: '중복 답변 확인' }).expect(201);
    await auth(api().post(`/internal/v1/reports/${created.body.reportId}/reply`), settler)
      .send({ reply: '첫 답변', rewardPoints: 100 })
      .expect(200);
    const again = await auth(api().post(`/internal/v1/reports/${created.body.reportId}/reply`), settler)
      .send({ reply: '두 번째 답변', rewardPoints: 100 })
      .expect(409);
    expect(again.body.error).toBe('ALREADY_ANSWERED');
  });

  it('답변이 오면 안 읽음으로 잡히고 읽음 처리는 멱등이다', async () => {
    const user = await seedUser(app);
    const created = await submit(user.accessToken, { body: '읽음 처리 확인' }).expect(201);
    await auth(api().post(`/internal/v1/reports/${created.body.reportId}/reply`), settler)
      .send({ reply: '답변드립니다' })
      .expect(200);

    const before = await auth(api().get('/v1/reports'), user.accessToken).expect(200);
    expect(before.body.unread).toBe(1);
    expect(before.body.reports[0].read).toBe(false);

    await auth(api().post(`/v1/reports/${created.body.reportId}/read`), user.accessToken).expect(200);
    await auth(api().post(`/v1/reports/${created.body.reportId}/read`), user.accessToken).expect(200);

    const after = await auth(api().get('/v1/reports'), user.accessToken).expect(200);
    expect(after.body.unread).toBe(0);
    expect(after.body.reports[0].read).toBe(true);
  });

  it('남의 제보는 읽음 처리할 수 없다', async () => {
    const owner = await seedUser(app);
    const other = await seedUser(app);
    const created = await submit(owner.accessToken, { body: '소유권 확인' }).expect(201);
    await auth(api().post(`/v1/reports/${created.body.reportId}/read`), other.accessToken).expect(404);
  });

  it('운영자 목록은 REVIEWER가 볼 수 있고 답변은 SETTLER만 한다', async () => {
    const user = await seedUser(app);
    const created = await submit(user.accessToken, { body: '권한 확인' }).expect(201);

    await auth(api().get('/internal/v1/reports'), reviewer).expect(200);
    await auth(api().post(`/internal/v1/reports/${created.body.reportId}/reply`), reviewer)
      .send({ reply: '권한 없는 답변' })
      .expect(403);
  });

  it('운영자 목록은 이메일을 마스킹하고 원문 열람은 감사에 남는다 (CLAW-236)', async () => {
    const user = await seedUser(app);
    const created = await submit(user.accessToken, {
      body: '마스킹 확인', replyEmail: 'masked@example.com', replyEmailConsent: true,
    }).expect(201);

    const list = await auth(api().get('/internal/v1/reports'), reviewer).expect(200);
    const row = list.body.find((r: { id: string }) => r.id === created.body.reportId);
    expect(row.replyEmailMasked).toMatch(/\*\*\*/);
    // 목록에 원문이 실려 나가면 안 된다.
    expect(JSON.stringify(list.body)).not.toContain('masked@example.com');
    expect(row.replyEmail).toBeUndefined();

    // 원문 열람은 POST다 — 감사 인터셉터가 GET을 기록하지 않기 때문이다.
    const revealed = await auth(api().post(`/internal/v1/reports/${created.body.reportId}/email`), settler)
      .expect(200);
    expect(revealed.body.replyEmail).toBe('masked@example.com');

    const audit = await dataSource.query(
      `SELECT action FROM audit_logs WHERE action LIKE '%reports/:id/email%' ORDER BY "createdAt" DESC LIMIT 1`,
    );
    expect(audit).toHaveLength(1);

    // REVIEWER는 원문을 볼 수 없다.
    await auth(api().post(`/internal/v1/reports/${created.body.reportId}/email`), reviewer).expect(403);
  });

  it('탈퇴하면 제보가 파기되고 내보내기에는 포함된다', async () => {
    const user = await seedUser(app);
    await submit(user.accessToken, { body: '탈퇴 파기 확인' }).expect(201);

    const exported = await auth(api().get('/v1/me/export'), user.accessToken).expect(200);
    expect(exported.body.reports).toHaveLength(1);

    await auth(api().delete('/v1/me'), user.accessToken).expect(200);
    const left = await dataSource.getRepository(Report).count({ where: { userId: user.userId } });
    expect(left).toBe(0);
  });
});
