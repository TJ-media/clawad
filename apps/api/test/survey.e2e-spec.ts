import './setup-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { loadPolicy } from '../src/common/policy';
import { GLOBAL_KILL_SWITCH_ID, KillSwitchTarget } from '../src/entities/kill-switch.entity';
import { RewardEntryType, RewardFunding, RewardLedgerEntry } from '../src/entities/reward-ledger.entity';
import { seedUser } from './social-helper';

const POLICY = loadPolicy();
const SURVEY = POLICY.survey;

/** 모든 필수 문항을 채운 유효한 응답. */
const validAnswers = () => ({
  usagePeriod: 'OVER_MONTH',
  overallSatisfaction: 'SATISFIED',
  adInterference: 'BARELY',
  accrualSpeed: 'REASONABLE',
  catalogSatisfaction: 'NOT_VISITED',
  continueIntent: 'WILL_CONTINUE',
  improvements: '적립 속도가 조금 아쉬워요',
});

describe('CLAW-97 만족도 설문·완료 리워드 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const auth = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  const submit = (token: string, body: unknown) =>
    auth(api().post('/v1/survey/responses'), token).send(body as object);

  it('미인증 요청은 401이다', async () => {
    await api().post('/v1/survey/responses').send({ surveyVersion: SURVEY.version, answers: validAnswers() }).expect(401);
    await api().get('/v1/survey/status').expect(401);
  });

  it('제출하면 정책값이 PROMO_ACCRUE로 즉시 확정 적립되고 확정 잔액에 반영된다', async () => {
    const user = await seedUser(app);

    const before = await auth(api().get('/v1/rewards'), user.accessToken).expect(200);
    expect(before.body.confirmedPoints).toBe(0);

    const status = await auth(api().get('/v1/survey/status'), user.accessToken).expect(200);
    expect(status.body).toMatchObject({
      surveyVersion: SURVEY.version,
      submitted: false,
      rewardPoints: SURVEY.completionRewardPoints,
    });

    const res = await submit(user.accessToken, { surveyVersion: SURVEY.version, answers: validAnswers() }).expect(201);
    expect(res.body).toMatchObject({
      surveyVersion: SURVEY.version,
      rewarded: true,
      points: SURVEY.completionRewardPoints,
      balancePoints: SURVEY.completionRewardPoints,
    });

    // 원장은 append-only 1행. 회사 재원이며 멱등 키에 설문 버전과 사용자가 들어간다.
    const entries = await dataSource.getRepository(RewardLedgerEntry).find({ where: { userId: user.userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: RewardEntryType.PROMO_ACCRUE,
      points: SURVEY.completionRewardPoints,
      funding: RewardFunding.COMPANY,
      refIdempotencyKey: `survey:${SURVEY.version}:${user.userId}`,
    });

    // 확정 잔액 집계(RewardService.confirmedBalance)에 PROMO_ACCRUE가 포함돼야 한다.
    const after = await auth(api().get('/v1/rewards'), user.accessToken).expect(200);
    expect(after.body.confirmedPoints).toBe(SURVEY.completionRewardPoints);
    expect(after.body.verifyingPoints).toBe(0);
  });

  it('재제출은 409이고 원장에 추가 적립을 만들지 않는다', async () => {
    const user = await seedUser(app);
    await submit(user.accessToken, { surveyVersion: SURVEY.version, answers: validAnswers() }).expect(201);

    const again = await submit(user.accessToken, { surveyVersion: SURVEY.version, answers: validAnswers() }).expect(409);
    expect(again.body.error).toBe('ALREADY_SUBMITTED');

    const entries = await dataSource.getRepository(RewardLedgerEntry).find({ where: { userId: user.userId } });
    expect(entries).toHaveLength(1);

    const status = await auth(api().get('/v1/survey/status'), user.accessToken).expect(200);
    expect(status.body.submitted).toBe(true);
  });

  it('동시 제출은 한 건만 적립된다', async () => {
    const user = await seedUser(app);
    const results = await Promise.all([
      submit(user.accessToken, { surveyVersion: SURVEY.version, answers: validAnswers() }),
      submit(user.accessToken, { surveyVersion: SURVEY.version, answers: validAnswers() }),
    ]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409]);

    const entries = await dataSource.getRepository(RewardLedgerEntry).find({ where: { userId: user.userId } });
    expect(entries).toHaveLength(1);
  });

  it('정의에 없는 문항 키·선택지는 400이고 아무것도 저장하지 않는다', async () => {
    const user = await seedUser(app);

    await submit(user.accessToken, {
      surveyVersion: SURVEY.version,
      answers: { ...validAnswers(), unknownKey: 'x' },
    }).expect(400);

    await submit(user.accessToken, {
      surveyVersion: SURVEY.version,
      answers: { ...validAnswers(), continueIntent: 'MAYBE' },
    }).expect(400);

    const missing = { ...validAnswers() } as Record<string, string>;
    delete missing.usagePeriod;
    await submit(user.accessToken, { surveyVersion: SURVEY.version, answers: missing }).expect(400);

    await submit(user.accessToken, {
      surveyVersion: SURVEY.version,
      answers: { ...validAnswers(), improvements: 'ㄱ'.repeat(1001) },
    }).expect(400);

    const entries = await dataSource.getRepository(RewardLedgerEntry).find({ where: { userId: user.userId } });
    expect(entries).toHaveLength(0);
    const status = await auth(api().get('/v1/survey/status'), user.accessToken).expect(200);
    expect(status.body.submitted).toBe(false);
  });

  it('활성 버전이 아닌 설문 제출은 400이다', async () => {
    const user = await seedUser(app);
    const res = await submit(user.accessToken, { surveyVersion: 'v0', answers: validAnswers() }).expect(400);
    expect(res.body.error).toBe('UNKNOWN_SURVEY_VERSION');
  });

  it('리워드 킬스위치가 켜져 있으면 적립도 응답 저장도 하지 않는다', async () => {
    const user = await seedUser(app);
    await dataSource.query(
      `INSERT INTO kill_switches ("target","targetId","active","reason")
       VALUES ($1,$2,true,'e2e')
       ON CONFLICT ("target","targetId") DO UPDATE SET active = true`,
      [KillSwitchTarget.GLOBAL_REWARDS, GLOBAL_KILL_SWITCH_ID],
    );
    try {
      const res = await submit(user.accessToken, { surveyVersion: SURVEY.version, answers: validAnswers() }).expect(503);
      expect(res.body.error).toBe('REWARDS_PAUSED');

      const entries = await dataSource.getRepository(RewardLedgerEntry).find({ where: { userId: user.userId } });
      expect(entries).toHaveLength(0);
      const status = await auth(api().get('/v1/survey/status'), user.accessToken).expect(200);
      expect(status.body.submitted).toBe(false);
    } finally {
      await dataSource.query(`UPDATE kill_switches SET active = false WHERE "target" = $1 AND "targetId" = $2`, [
        KillSwitchTarget.GLOBAL_REWARDS,
        GLOBAL_KILL_SWITCH_ID,
      ]);
    }
  });
});
