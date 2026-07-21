import './setup-env';
import { loginBootstrapAdmin, loginAsRole } from './admin-helper';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AdminRole } from '../src/admin/admin-user.entity';
import { RedemptionLedgerEntry } from '../src/redemption/redemption-ledger.entity';
import { RedemptionStatus } from '../src/redemption/redemption.entity';
import { seedUser } from './social-helper';

let superToken: string;

describe('CLAW-26 수동 교환·지급 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    superToken = await loginBootstrapAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const admin = (r: request.Test, token = superToken) => r.set('Authorization', `Bearer ${token}`);

  async function makeUser() {
    const { accessToken, userId } = await seedUser(app);
    return { accessToken, userId };
  }

  const bearer = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  // 교환에는 발송 이메일과 동의가 필수다 (CLAW-74). 기본 페이로드에 실어 각 요청에 spread한다.
  const DELIV = { deliveryEmail: 'alpha@example.com', deliveryEmailConsent: true } as const;

  /** 확정 리워드를 원장에 직접 심는다. */
  async function seedConfirmed(userId: string, points: number) {
    await dataSource.query(
      `INSERT INTO reward_ledger ("userId","entryType","points","refIdempotencyKey") VALUES ($1,'ACCRUE_CONFIRM',$2,$3)`,
      [userId, points, randomBytes(16).toString('hex')],
    );
  }

  async function createProduct(pointCost = 3000, name = '편의점 3천원권') {
    const res = await admin(api().post('/internal/v1/products'))
      .send({ name, brand: 'GS25', pointCost })
      .expect(201);
    return res.body.id as string;
  }

  const rewardsOf = (accessToken: string) =>
    api().get('/v1/rewards').set('Authorization', `Bearer ${accessToken}`).expect(200);

  describe('상품 카탈로그', () => {
    it('SUPERADMIN만 상품을 만들 수 있다', async () => {
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
      await bearer(api().post('/internal/v1/products'), settler)
        .send({ name: 'x', brand: 'y', pointCost: 3000 })
        .expect(403);
    });

    it('최소 교환액 미만 상품은 만들 수 없다', async () => {
      const res = await admin(api().post('/internal/v1/products'))
        .send({ name: 'x', brand: 'y', pointCost: 100 })
        .expect(400);
      expect(res.body.error).toBe('POINT_COST_BELOW_MINIMUM');
    });

    it('사용자는 활성 상품 카탈로그를 조회한다', async () => {
      await createProduct();
      const { accessToken } = await makeUser();
      const res = await bearer(api().get('/v1/rewards/products'), accessToken).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('상품에 category를 지정하면 저장·반환된다 (샵 필터용)', async () => {
      const res = await admin(api().post('/internal/v1/products'))
        .send({ name: '아메리카노', brand: '메가커피', pointCost: 2500, category: 'CAFE' })
        .expect(201);
      expect(res.body.category).toBe('CAFE');
    });

    it('최소 교환액(1,500P) 이상이면 저가 카페 상품도 등록된다', async () => {
      // CLAW-36에서 최소 교환액을 3,000→1,500으로 낮춰 저가 카페 실가격을 담는다.
      await admin(api().post('/internal/v1/products'))
        .send({ name: '아메리카노', brand: '컴포즈커피', pointCost: 1500, category: 'CAFE' })
        .expect(201);
    });
  });

  describe('교환 멱등성 (CLAW-73)', () => {
    const redemptionCount = async (userId: string) =>
      Number((await dataSource.query(`SELECT COUNT(*)::int AS n FROM redemptions WHERE "userId" = $1`, [userId]))[0].n);
    const debitCount = async (userId: string) =>
      Number(
        (
          await dataSource.query(
            `SELECT COUNT(*)::int AS n FROM reward_ledger WHERE "userId" = $1 AND "entryType" = 'REDEEM_DEBIT'`,
            [userId],
          )
        )[0].n,
      );

    it('응답 유실 후 같은 키 재시도는 최초 주문을 반환하고 추가 차감이 없다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 5000);
      const idempotencyKey = randomUUID();

      const first = await bearer(api().post('/v1/rewards/redeem'), accessToken)
        .send({ productId, idempotencyKey, ...DELIV })
        .expect(201);
      const retry = await bearer(api().post('/v1/rewards/redeem'), accessToken)
        .send({ productId, idempotencyKey, ...DELIV })
        .expect(201);

      expect(retry.body.id).toBe(first.body.id);
      expect(await redemptionCount(userId)).toBe(1);
      expect(await debitCount(userId)).toBe(1);
      expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(2000); // 5000 - 3000, 한 번만
    });

    it('같은 키 동시 요청에서도 주문·차감이 한 건뿐이다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 10000);
      const idempotencyKey = randomUUID();

      const results = await Promise.all([
        bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, idempotencyKey, ...DELIV }),
        bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, idempotencyKey, ...DELIV }),
      ]);
      for (const res of results) expect(res.status).toBe(201);
      expect(results[0].body.id).toBe(results[1].body.id);
      expect(await redemptionCount(userId)).toBe(1);
      expect(await debitCount(userId)).toBe(1);
    });

    it('같은 키에 다른 상품을 보내면 409 IDEMPOTENCY_CONFLICT', async () => {
      const productA = await createProduct(3000);
      const productB = await createProduct(3000, '편의점 3천원권 B');
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 10000);
      const idempotencyKey = randomUUID();

      await bearer(api().post('/v1/rewards/redeem'), accessToken)
        .send({ productId: productA, idempotencyKey, ...DELIV })
        .expect(201);
      const conflict = await bearer(api().post('/v1/rewards/redeem'), accessToken)
        .send({ productId: productB, idempotencyKey, ...DELIV })
        .expect(409);
      expect(conflict.body.error).toBe('IDEMPOTENCY_CONFLICT');
      expect(await redemptionCount(userId)).toBe(1); // 두 번째 주문·차감 없음
    });

    it('UUID 형식이 아닌 키는 400으로 거절된다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 5000);
      await bearer(api().post('/v1/rewards/redeem'), accessToken)
        .send({ productId, idempotencyKey: 'not-a-uuid', ...DELIV })
        .expect(400);
      expect(await redemptionCount(userId)).toBe(0);
    });

    it('키 없는 레거시 요청은 기존 동작 그대로다 (멱등 보장 없음)', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 10000);

      await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }).expect(201);
      await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }).expect(201);
      // 키가 없으면 서로 다른 의도로 본다 — 두 건 생성(하위호환).
      expect(await redemptionCount(userId)).toBe(2);
      expect(await debitCount(userId)).toBe(2);
    });
  });

  describe('교환 신청', () => {
    it('확정 포인트로 교환하면 잔액이 차감된다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 5000);

      const res = await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }).expect(201);
      expect(res.body.status).toBe(RedemptionStatus.REQUESTED);
      expect(res.body.pointsDebited).toBe(3000);

      expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(2000); // 5000 - 3000
    });

    it('확정 포인트가 부족하면 409', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 1000);

      const res = await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }).expect(409);
      expect(res.body.error).toBe('INSUFFICIENT_CONFIRMED_POINTS');
      expect(res.body.confirmedPoints).toBe(1000);
    });

    it('검증 중(pending) 포인트로는 교환할 수 없다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      // pending만 5000 (확정 아님)
      await dataSource.query(
        `INSERT INTO reward_ledger ("userId","entryType","points","refIdempotencyKey") VALUES ($1,'ACCRUE_PENDING',5000,$2)`,
        [userId, randomBytes(16).toString('hex')],
      );
      await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }).expect(409);
    });

    it('동시 교환 신청에서도 잔액을 초과 차감하지 않는다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 5000); // 3000짜리 하나만 가능

      const results = await Promise.allSettled([
        bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }),
        bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }),
      ]);
      const created = results.filter((r) => r.status === 'fulfilled' && (r.value as request.Response).status === 201);
      expect(created).toHaveLength(1); // 한 건만 성공
      expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(2000);
    });
  });

  describe('운영자 수동 지급', () => {
    async function requestOne() {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 3000);
      const res = await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }).expect(201);
      return { accessToken, userId, redemptionId: res.body.id as string };
    }

    it('SETTLER가 수동 발송 후 지급 완료 처리한다', async () => {
      const { redemptionId } = await requestOne();
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);

      const res = await bearer(api().post(`/internal/v1/redemptions/${redemptionId}/deliver`), settler)
        .send({ supplierRef: '수동발송-주문123' })
        .expect(200);
      expect(res.body.status).toBe(RedemptionStatus.DELIVERED);
    });

    it('발송 대기 큐에 REQUESTED 교환이 보인다', async () => {
      const { redemptionId } = await requestOne();
      const res = await admin(api().get('/internal/v1/redemptions/pending')).expect(200);
      expect(res.body.some((r: { id: string }) => r.id === redemptionId)).toBe(true);
    });

    it('취소하면 차감한 포인트가 원복된다', async () => {
      const { accessToken, redemptionId } = await requestOne();
      expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(0); // 3000 차감됨

      await admin(api().post(`/internal/v1/redemptions/${redemptionId}/cancel`)).send({ reason: 'user_request' }).expect(200);
      expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(3000); // 원복
    });

    it('발송 실패하면 포인트가 원복된다', async () => {
      const { accessToken, redemptionId } = await requestOne();
      await admin(api().post(`/internal/v1/redemptions/${redemptionId}/fail`)).send({ reason: 'oos' }).expect(200);
      expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(3000);
    });

    it('지급 완료된 교환은 다시 전이할 수 없다 (이중 처리 방지)', async () => {
      const { redemptionId } = await requestOne();
      await admin(api().post(`/internal/v1/redemptions/${redemptionId}/deliver`)).send({}).expect(200);
      // 이미 DELIVERED → 취소 불가
      await admin(api().post(`/internal/v1/redemptions/${redemptionId}/cancel`)).send({}).expect(400);
    });

    it('취소된 교환을 다시 취소해도 이중 원복되지 않는다', async () => {
      const { accessToken, redemptionId } = await requestOne();
      await admin(api().post(`/internal/v1/redemptions/${redemptionId}/cancel`)).send({}).expect(200);
      await admin(api().post(`/internal/v1/redemptions/${redemptionId}/cancel`)).send({}).expect(400); // 이미 종료
      expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(3000); // 이중 원복 없음
    });
  });

  describe('원장·프라이버시', () => {
    it('지급 원장은 append-only — DB가 UPDATE·DELETE를 거부한다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 3000);
      await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId, ...DELIV }).expect(201);

      const entry = await dataSource.getRepository(RedemptionLedgerEntry).findOneOrFail({ where: { userId } });
      await expect(
        dataSource.query(`UPDATE redemption_ledger SET detail='x' WHERE id=$1`, [entry.id]),
      ).rejects.toThrow(/append-only/);
      await expect(dataSource.query(`DELETE FROM redemption_ledger WHERE id=$1`, [entry.id])).rejects.toThrow(
        /append-only/,
      );
    });

    it('redemptions·redemption_ledger에 세율 컬럼·전화 연락처·IP 컬럼이 없다', async () => {
      // 발송 이메일(deliveryEmail)은 CLAW-74로 허용되지만, 전화번호·IP·세율은 여전히 금지다.
      const cols = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name IN ('redemptions','redemption_ledger')
           AND (column_name ILIKE '%rate%' OR column_name ILIKE '%phone%' OR column_name ILIKE '%tel%' OR column_name ILIKE '%ip%')`,
      );
      expect(cols).toHaveLength(0);
    });
  });

  describe('발송 이메일 수집·마스킹·파기 (CLAW-74)', () => {
    async function redeemWithEmail(deliveryEmail: string) {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 3000);
      const res = await bearer(api().post('/v1/rewards/redeem'), accessToken)
        .send({ productId, deliveryEmail, deliveryEmailConsent: true })
        .expect(201);
      return { accessToken, userId, redemptionId: res.body.id as string };
    }

    it('발송 이메일 없이 교환하면 400 (지급 경로 보장)', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 3000);
      await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId }).expect(400);
      const n = await dataSource.query(`SELECT COUNT(*)::int AS n FROM redemptions WHERE "userId"=$1`, [userId]);
      expect(n[0].n).toBe(0);
    });

    it('이메일 형식이 잘못되면 400', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 3000);
      await bearer(api().post('/v1/rewards/redeem'), accessToken)
        .send({ productId, deliveryEmail: 'not-an-email', deliveryEmailConsent: true })
        .expect(400);
    });

    it('동의하지 않으면 400 (deliveryEmailConsent는 반드시 true)', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 3000);
      await bearer(api().post('/v1/rewards/redeem'), accessToken)
        .send({ productId, deliveryEmail: 'user@example.com', deliveryEmailConsent: false })
        .expect(400);
    });

    it('응답·내 내역·대기 큐에는 마스킹된 이메일만 노출하고 원문은 없다', async () => {
      const { accessToken, redemptionId } = await redeemWithEmail('taejeong@example.com');

      // 교환 응답
      const mine = await bearer(api().get('/v1/rewards/redemptions'), accessToken).expect(200);
      const row = mine.body.find((r: { id: string }) => r.id === redemptionId);
      expect(row.deliveryEmailMasked).toBe('ta***@ex***.com');
      expect(JSON.stringify(mine.body)).not.toContain('taejeong@example.com');

      // 운영자 대기 큐
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
      const pending = await bearer(api().get('/internal/v1/redemptions/pending'), settler).expect(200);
      const p = pending.body.find((r: { id: string }) => r.id === redemptionId);
      expect(p.deliveryEmailMasked).toBe('ta***@ex***.com');
      expect(JSON.stringify(pending.body)).not.toContain('taejeong@example.com');
    });

    it('SETTLER의 reveal-email만 원문을 반환하고 감사로그가 남는다', async () => {
      const { redemptionId } = await redeemWithEmail('reveal@example.com');
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);

      const res = await bearer(api().post(`/internal/v1/redemptions/${redemptionId}/reveal-email`), settler).expect(200);
      expect(res.body.deliveryEmail).toBe('reveal@example.com');

      const audit = await dataSource.query(
        `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action ILIKE '%reveal-email%' AND "targetId"=$1`,
        [redemptionId],
      );
      expect(audit[0].n).toBeGreaterThan(0);
    });

    it('발송 완료(DELIVERED) 시 발송 이메일은 파기하되 동의 증적은 유지한다', async () => {
      const { redemptionId } = await redeemWithEmail('bye@example.com');
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
      // 발송 전에는 원문 확인(reveal) 가능
      await bearer(api().post(`/internal/v1/redemptions/${redemptionId}/reveal-email`), settler).expect(200);
      await bearer(api().post(`/internal/v1/redemptions/${redemptionId}/deliver`), settler).send({}).expect(200);

      const rows = await dataSource.query(
        `SELECT "deliveryEmail","deliveryEmailConsentAt" FROM redemptions WHERE id=$1`,
        [redemptionId],
      );
      expect(rows[0].deliveryEmail).toBeNull(); // 발송 후 즉시 파기
      expect(rows[0].deliveryEmailConsentAt).not.toBeNull(); // 동의 시각은 증적으로 유지
      // 파기 후에는 reveal할 원문이 없다
      await bearer(api().post(`/internal/v1/redemptions/${redemptionId}/reveal-email`), settler).expect(404);
    });

    it('발송 대기(REQUESTED) 교환이 있으면 탈퇴가 차단된다', async () => {
      const { accessToken } = await redeemWithEmail('hold@example.com');
      const res = await bearer(api().delete('/v1/me'), accessToken).send({}).expect(409);
      expect(res.body.error).toBe('REDEMPTION_IN_PROGRESS');
    });

    it('취소로 종결하면 발송 이메일이 파기되고, 이후 탈퇴해도 잔여 원문이 없다', async () => {
      const { accessToken, userId, redemptionId } = await redeemWithEmail('cancel@example.com');
      await admin(api().post(`/internal/v1/redemptions/${redemptionId}/cancel`)).send({}).expect(200);
      const afterCancel = await dataSource.query(`SELECT "deliveryEmail" FROM redemptions WHERE id=$1`, [redemptionId]);
      expect(afterCancel[0].deliveryEmail).toBeNull(); // 취소 종결 시 파기 + 포인트 3000 원복

      // 원복된 확정 3000은 포기 동의로 정리하고 탈퇴한다(미종결 교환 없음).
      await bearer(api().delete('/v1/me'), accessToken).send({ forfeitConfirmedRewards: true }).expect(200);
      const rows = await dataSource.query(`SELECT "deliveryEmail" FROM redemptions WHERE "userId"=$1`, [userId]);
      expect(rows.every((r: { deliveryEmail: string | null }) => r.deliveryEmail === null)).toBe(true);
    });
  });
});
