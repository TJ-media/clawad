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
import { Machine, MachineStatus } from '../src/entities/machine.entity';
import { CampaignStatus, CampaignType } from '../src/entities/campaign.entity';
import { BillingEntryType } from '../src/entities/billing-ledger.entity';
import { seedUser } from './social-helper';

let adminToken: string;
const POLICY = loadPolicy();

const newMachineId = () => randomBytes(16).toString('hex');

describe('CLAW-24 ad-decision·serveToken 발급 (e2e)', () => {
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

  const signupWithMachine = async () => {
    const { accessToken, userId } = await seedUser(app);
    const machineId = newMachineId();
    await api()
      .post('/v1/machines')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ machineId })
      .expect(200);
    return { accessToken, userId, machineId };
  };

  const decide = (accessToken: string, machineId: string) =>
    api().get('/v1/ad-decision').set('Authorization', `Bearer ${accessToken}`).set('x-clawad-machine-id', machineId);

  const prefetchStatus = (accessToken: string, machineId: string) =>
    api()
      .get('/v1/ad-decision/prefetch-status')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-clawad-machine-id', machineId);

  /** ACTIVE PAID 캠페인 하나를 만들어 서빙 풀에 올린다. */
  const seedActiveCampaign = async () => {
    await dataSource.query(`UPDATE campaigns SET status = 'ENDED' WHERE status = 'ACTIVE'`);

    const adv = await admin(api().post('/internal/v1/advertisers')).send({ name: `ad-${randomUUID().slice(0, 8)}` });
    const cam = await admin(api().post('/internal/v1/campaigns')).send({
      advertiserId: adv.body.id,
      name: 'ad-decision 테스트',
      type: CampaignType.PAID,
      pricePerImpressionKrw: 2,
    });
    const campaignId = cam.body.id as string;

    const cr = await admin(api().post(`/internal/v1/campaigns/${campaignId}/creatives`)).send({
      text: '광고 문구입니다',
      brand: '브랜드',
    });
    await admin(api().post(`/internal/v1/creatives/${cr.body.id}/review`)).send({ approve: true }).expect(200);
    for (const to of [CampaignStatus.PENDING_REVIEW, CampaignStatus.APPROVED, CampaignStatus.ACTIVE]) {
      await admin(api().post(`/internal/v1/campaigns/${campaignId}/transition`)).send({ to }).expect(200);
    }
    await admin(api().post(`/internal/v1/campaigns/${campaignId}/budget/credit`))
      .send({ entryType: BillingEntryType.DEPOSIT, amountKrw: 100000 })
      .expect(201);

    return { campaignId, creativeId: cr.body.id as string };
  };

  describe('인증·기기 경계', () => {
    it('토큰 없이 호출하면 401', async () => {
      await api().get('/v1/ad-decision').set('x-clawad-machine-id', newMachineId()).expect(401);
    });

    it('등록되지 않은 기기는 404', async () => {
      const { accessToken } = await signupWithMachine();
      await decide(accessToken, newMachineId()).expect(404);
    });

    it('machineId 형식이 틀리면 400 (하드웨어 식별자 차단)', async () => {
      const { accessToken } = await signupWithMachine();
      await decide(accessToken, '00:11:22:33:44:55').expect(400);
    });

    it('차단된 기기는 403', async () => {
      const { accessToken, machineId } = await signupWithMachine();
      await dataSource.getRepository(Machine).update({ machineId }, { status: MachineStatus.BLOCKED });
      await decide(accessToken, machineId).expect(403);
    });
  });

  describe('serveToken 발급', () => {
    it('서명된 토큰과 광고 번들을 반환한다 ([광고] 표기 강제)', async () => {
      await seedActiveCampaign();
      const { accessToken, userId, machineId } = await signupWithMachine();

      const res = await decide(accessToken, machineId).expect(200);
      expect(res.body.serveToken).toMatch(/^[\w-]+\.[\w-]+$/);
      expect(res.body.ad.label).toBe('광고');
      expect(res.body.minViewMs).toBe(POLICY.impression.minViewMs);
      expect(res.body.expiresAt).toBeGreaterThan(Date.now());

      // 토큰에 금액이 들어있지 않다. 단가는 서버만 안다.
      const payload = JSON.parse(Buffer.from(res.body.serveToken.split('.')[0], 'base64url').toString('utf8'));
      expect(payload.jti).toBeTruthy();
      expect(payload.userId).toBe(userId);
      expect(payload.machineId).toBe(machineId);
      expect(payload).not.toHaveProperty('pricePerImpressionKrw');
      expect(res.body.ad).not.toHaveProperty('pricePerImpressionKrw');
    });

    it('토큰은 인증 사용자와 요청 기기에 바인딩된다', async () => {
      await seedActiveCampaign();
      const a = await signupWithMachine();
      const res = await decide(a.accessToken, a.machineId).expect(200);
      const payload = JSON.parse(Buffer.from(res.body.serveToken.split('.')[0], 'base64url').toString('utf8'));
      expect(payload.userId).toBe(a.userId);
      expect(payload.machineId).toBe(a.machineId);
    });

    it('서빙 가능한 캠페인이 없으면 404', async () => {
      await dataSource.query(`UPDATE campaigns SET status = 'ENDED' WHERE status = 'ACTIVE'`);
      const { accessToken, machineId } = await signupWithMachine();
      await decide(accessToken, machineId).expect(404);
    });
  });

  describe('프리페치 상한', () => {
    it(`미사용 토큰이 ${POLICY.serveToken.maxUnusedTokensPerMachine}개면 429로 막는다`, async () => {
      await seedActiveCampaign();
      const { accessToken, machineId } = await signupWithMachine();

      for (let i = 0; i < POLICY.serveToken.maxUnusedTokensPerMachine; i++) {
        await decide(accessToken, machineId).expect(200);
      }
      const res = await decide(accessToken, machineId).expect(429);
      expect(res.body.error).toBe('PREFETCH_LIMIT_EXCEEDED');
      expect(res.body.limit).toBe(POLICY.serveToken.maxUnusedTokensPerMachine);
    });

    it('prefetch-status가 미사용 수·상한·리필 필요 여부를 알려준다', async () => {
      await seedActiveCampaign();
      const { accessToken, machineId } = await signupWithMachine();

      const before = await prefetchStatus(accessToken, machineId).expect(200);
      expect(before.body).toEqual({
        unused: 0,
        limit: POLICY.serveToken.maxUnusedTokensPerMachine,
        needsRefill: true,
      });

      for (let i = 0; i < POLICY.serveToken.maxUnusedTokensPerMachine; i++) {
        await decide(accessToken, machineId).expect(200);
      }
      const after = await prefetchStatus(accessToken, machineId).expect(200);
      expect(after.body.unused).toBe(POLICY.serveToken.maxUnusedTokensPerMachine);
      expect(after.body.needsRefill).toBe(false);
    });

    it('캐시 유실 복구: 미사용 토큰을 멱등 폐기하고 다시 받을 수 있다', async () => {
      await seedActiveCampaign();
      const { accessToken, machineId } = await signupWithMachine();

      for (let i = 0; i < POLICY.serveToken.maxUnusedTokensPerMachine; i++) {
        await decide(accessToken, machineId).expect(200);
      }
      await decide(accessToken, machineId).expect(429);

      const revoke = () =>
        api()
          .delete('/v1/ad-decision/prefetched-tokens')
          .set('Authorization', `Bearer ${accessToken}`)
          .set('x-clawad-machine-id', machineId);

      const first = await revoke().expect(200);
      expect(first.body.revoked).toBe(POLICY.serveToken.maxUnusedTokensPerMachine);

      // 멱등: 두 번째 호출은 폐기할 것이 없다.
      const second = await revoke().expect(200);
      expect(second.body.revoked).toBe(0);

      // 폐기 후에는 다시 발급받을 수 있다.
      await decide(accessToken, machineId).expect(200);
    });

    it('다른 기기의 상한은 서로 독립이다', async () => {
      await seedActiveCampaign();
      const { accessToken, machineId } = await signupWithMachine();
      const second = newMachineId();
      await api()
        .post('/v1/machines')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ machineId: second })
        .expect(200);

      for (let i = 0; i < POLICY.serveToken.maxUnusedTokensPerMachine; i++) {
        await decide(accessToken, machineId).expect(200);
      }
      await decide(accessToken, machineId).expect(429);
      // 두 번째 기기는 아직 여유가 있다.
      await decide(accessToken, second).expect(200);
    });
  });
});
