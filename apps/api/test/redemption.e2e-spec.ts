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
import { ConsentType } from '../src/entities/consent.entity';
import { RedemptionLedgerEntry } from '../src/redemption/redemption-ledger.entity';
import { RedemptionStatus } from '../src/redemption/redemption.entity';

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
    const res = await api()
      .post('/v1/auth/signup')
      .send({
        email: `rd-${randomUUID()}@example.test`,
        password: 'correct-horse-battery',
        consents: [
          { type: ConsentType.TERMS_OF_SERVICE, granted: true, documentVersion: 'v0' },
          { type: ConsentType.PRIVACY_POLICY, granted: true, documentVersion: 'v0' },
        ],
      })
      .expect(201);
    return { accessToken: res.body.accessToken as string, userId: decodeSub(res.body.accessToken) };
  }

  const bearer = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

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

  describe('교환 신청', () => {
    it('확정 포인트로 교환하면 잔액이 차감된다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 5000);

      const res = await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId }).expect(201);
      expect(res.body.status).toBe(RedemptionStatus.REQUESTED);
      expect(res.body.pointsDebited).toBe(3000);

      expect((await rewardsOf(accessToken)).body.confirmedPoints).toBe(2000); // 5000 - 3000
    });

    it('확정 포인트가 부족하면 409', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 1000);

      const res = await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId }).expect(409);
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
      await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId }).expect(409);
    });

    it('동시 교환 신청에서도 잔액을 초과 차감하지 않는다', async () => {
      const productId = await createProduct(3000);
      const { accessToken, userId } = await makeUser();
      await seedConfirmed(userId, 5000); // 3000짜리 하나만 가능

      const results = await Promise.allSettled([
        bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId }),
        bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId }),
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
      const res = await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId }).expect(201);
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
      await bearer(api().post('/v1/rewards/redeem'), accessToken).send({ productId }).expect(201);

      const entry = await dataSource.getRepository(RedemptionLedgerEntry).findOneOrFail({ where: { userId } });
      await expect(
        dataSource.query(`UPDATE redemption_ledger SET detail='x' WHERE id=$1`, [entry.id]),
      ).rejects.toThrow(/append-only/);
      await expect(dataSource.query(`DELETE FROM redemption_ledger WHERE id=$1`, [entry.id])).rejects.toThrow(
        /append-only/,
      );
    });

    it('redemptions·redemption_ledger에 세율 컬럼·쿠폰 연락처 컬럼이 없다', async () => {
      const cols = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name IN ('redemptions','redemption_ledger')
           AND (column_name ILIKE '%rate%' OR column_name ILIKE '%phone%' OR column_name ILIKE '%tel%' OR column_name ILIKE '%ip%')`,
      );
      expect(cols).toHaveLength(0);
    });
  });
});

function decodeSub(jwt: string): string {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).sub;
}
