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
import { AdDecisionController } from '../src/campaigns/ad-decision.controller';
import { ServeTokenService } from '../src/campaigns/serve-token.service';
import { KillSwitchService } from '../src/events/kill-switch.service';

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

  const decide = (accessToken: string, machineId: string, rehearsalMode?: string) => {
    const response = api()
      .get('/v1/ad-decision')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-clawad-machine-id', machineId);
    return rehearsalMode ? response.set('x-clawad-rehearsal-mode', rehearsalMode) : response;
  };

  const prefetchStatus = (accessToken: string, machineId: string, campaignIds: string[] = []) => {
    const response = api()
      .get('/v1/ad-decision/prefetch-status')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-clawad-machine-id', machineId);
    return campaignIds.length > 0
      ? response.set('x-clawad-campaign-ids', campaignIds.join(','))
      : response;
  };

  /** ACTIVE PAID 캠페인 하나를 만들어 서빙 풀에 올린다. */
  const seedActiveCampaign = async (
    landingUrl?: string,
    advertiserDailyLimit?: number,
    type = CampaignType.PAID,
  ) => {
    await dataSource.query(`UPDATE campaigns SET status = 'ENDED' WHERE status = 'ACTIVE'`);

    const adv = await admin(api().post('/internal/v1/advertisers')).send({
      name: `ad-${randomUUID().slice(0, 8)}`,
      ...(advertiserDailyLimit === undefined ? {} : { dailyImpressionLimit: advertiserDailyLimit }),
    });
    const cam = await admin(api().post('/internal/v1/campaigns')).send({
      advertiserId: adv.body.id,
      name: 'ad-decision 테스트',
      type,
      pricePerImpressionKrw: type === CampaignType.PAID ? 2 : 0,
    });
    const campaignId = cam.body.id as string;

    const cr = await admin(api().post(`/internal/v1/campaigns/${campaignId}/creatives`)).send({
      text: '광고 문구입니다',
      brand: '브랜드',
      ...(landingUrl ? { landingUrl } : {}),
    });
    await admin(api().post(`/internal/v1/creatives/${cr.body.id}/review`)).send({ approve: true }).expect(200);
    for (const to of [CampaignStatus.PENDING_REVIEW, CampaignStatus.APPROVED, CampaignStatus.ACTIVE]) {
      await admin(api().post(`/internal/v1/campaigns/${campaignId}/transition`)).send({ to }).expect(200);
    }
    if (type === CampaignType.PAID) {
      await admin(api().post(`/internal/v1/campaigns/${campaignId}/budget/credit`))
        .send({ entryType: BillingEntryType.DEPOSIT, amountKrw: 100000 })
        .expect(201);
    }

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
    it('DB pool 2개를 동시 shared gate가 점유해도 추가 커넥션 없이 발급을 완료한다', async () => {
      // 정책 snapshot hash도 새 값으로 만들어 동시 ON CONFLICT 수렴 경로를 함께 검증한다.
      await seedActiveCampaign(undefined, 900_000_000 + Math.floor(Math.random() * 10_000_000));
      const { accessToken, machineId } = await signupWithMachine();
      const controller = app.get(AdDecisionController) as unknown as { killSwitch: KillSwitchService };
      const switches = controller.killSwitch;
      const originalAcquire = switches.acquireAdsShared.bind(switches);
      const pool = (dataSource.driver as unknown as {
        master: { options: { max: number }; totalCount: number };
      }).master;
      const originalMax = pool.options.max;
      expect(pool.totalCount).toBeLessThanOrEqual(2);
      pool.options.max = 2;

      let arrived = 0;
      let release!: () => void;
      let bothArrived!: () => void;
      const releaseBarrier = new Promise<void>((resolve) => (release = resolve));
      const arrivalBarrier = new Promise<void>((resolve) => (bothArrived = resolve));
      const gateSpy = jest.spyOn(switches, 'acquireAdsShared').mockImplementation(async (manager) => {
        await originalAcquire(manager);
        arrived += 1;
        if (arrived === 2) bothArrived();
        await releaseBarrier;
      });

      const requests = [decide(accessToken, machineId), decide(accessToken, machineId)].map((test) =>
        test.then((response) => response),
      );
      let arrivalTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          arrivalBarrier,
          new Promise<never>((_, reject) => {
            arrivalTimeout = setTimeout(
              () => reject(new Error('shared gate가 DB pool 2개에 진입하지 못했습니다.')),
              2_000,
            );
          }),
        ]);
        clearTimeout(arrivalTimeout);
        release();
        const responses = await Promise.all(requests);
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
      } finally {
        clearTimeout(arrivalTimeout);
        release();
        gateSpy.mockRestore();
        pool.options.max = originalMax;
      }
    });

    it('서명된 토큰과 광고 번들을 반환한다 ([광고] 표기 강제)', async () => {
      await seedActiveCampaign();
      const { accessToken, userId, machineId } = await signupWithMachine();

      const res = await decide(accessToken, machineId).expect(200);
      expect(res.body.serveToken).toMatch(/^[\w-]+\.[\w-]+$/);
      expect(res.body.ad.label).toBe('광고');
      expect(res.body.minViewMs).toBe(POLICY.impression.minViewMs);
      expect(res.body.expiresAt).toBeGreaterThan(Date.now());

      // 정책 스냅샷은 서명된 토큰 안에만 있고 광고 응답에는 노출하지 않는다.
      const payload = JSON.parse(Buffer.from(res.body.serveToken.split('.')[0], 'base64url').toString('utf8'));
      expect(payload.jti).toBeTruthy();
      expect(payload.userId).toBe(userId);
      expect(payload.machineId).toBe(machineId);
      expect(payload.policySnapshotId).toMatch(/^[0-9a-f-]{36}$/);
      expect(payload.policySnapshot).toMatchObject({
        policyVersion: POLICY.version,
        billingEligible: true,
        rewardEligible: true,
        pricePerImpressionKrw: 2,
        rewardPerThousandAcceptedImpressions: POLICY.reward.rewardPerThousandAcceptedImpressions,
        minViewMs: POLICY.impression.minViewMs,
        maxContinuousSessionMs: POLICY.abuse.maxContinuousSessionMs,
        continuousSessionMaxGapMs: POLICY.abuse.continuousSessionMaxGapMs,
      });
      expect(res.body.ad).not.toHaveProperty('pricePerImpressionKrw');
    });

    it('TEST는 명시적 리허설 모드에서만 무과금·무리워드 토큰으로 서빙한다', async () => {
      await seedActiveCampaign(undefined, undefined, CampaignType.TEST);
      const { accessToken, machineId } = await signupWithMachine();

      await decide(accessToken, machineId).expect(404);
      process.env.CLAWAD_TEST_REHEARSAL_ENABLED = 'false';
      try {
        await decide(accessToken, machineId, 'TEST').expect(403, { error: 'TEST_REHEARSAL_DISABLED' });
      } finally {
        process.env.CLAWAD_TEST_REHEARSAL_ENABLED = 'true';
      }
      const res = await decide(accessToken, machineId, 'TEST').expect(200);
      expect(res.body.ad).toMatchObject({ label: '광고', campaignType: CampaignType.TEST });
      const payload = JSON.parse(Buffer.from(res.body.serveToken.split('.')[0], 'base64url').toString('utf8'));
      expect(payload.campaignType).toBe(CampaignType.TEST);
      expect(payload.policySnapshot).toMatchObject({
        billingEligible: false,
        rewardEligible: false,
        pricePerImpressionKrw: 0,
        rewardPolicyId: null,
      });

      await decide(accessToken, machineId, 'PAID').expect(400, { error: 'INVALID_REHEARSAL_MODE' });
    });

    it('클릭 URL은 serveToken 없이 한 번 기록하고 목적지로 보낸다', async () => {
      await seedActiveCampaign('https://example.com/campaign');
      const { accessToken, machineId } = await signupWithMachine();
      const decision = await decide(accessToken, machineId).expect(200);
      expect(decision.body.clickUrl).toMatch(/\/v1\/click\//);
      expect(decision.body.clickUrl).not.toContain(decision.body.serveToken);

      const first = await api().get(new URL(decision.body.clickUrl).pathname).redirects(0).expect(302);
      expect(first.headers.location).toBe('https://example.com/campaign');
      await api().get(new URL(decision.body.clickUrl).pathname).redirects(0).expect(409);
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
        paused: false,
        blockedCampaignIds: [],
      });

      for (let i = 0; i < POLICY.serveToken.maxUnusedTokensPerMachine; i++) {
        await decide(accessToken, machineId).expect(200);
      }
      const after = await prefetchStatus(accessToken, machineId).expect(200);
      expect(after.body.unused).toBe(POLICY.serveToken.maxUnusedTokensPerMachine);
      expect(after.body.needsRefill).toBe(false);
      expect(after.body.paused).toBe(false);
    });

    // 토큰은 한 배치로 발급돼 만료도 동시에 온다. 개수만 보면 절벽 직전까지 충분해 보여
    // 리필이 억제되고, 배치가 죽은 뒤 다음 sync까지 광고 공백이 생긴다 (CLAW-106).
    it('개수가 충분해도 배치가 곧 만료되면 리필이 필요하다고 판단한다 (CLAW-106)', async () => {
      await seedActiveCampaign();
      const { accessToken, machineId } = await signupWithMachine();
      for (let i = 0; i < POLICY.serveToken.maxUnusedTokensPerMachine; i++) {
        await decide(accessToken, machineId).expect(200);
      }
      const serveToken = app.get(ServeTokenService);

      // 지금은 개수도 상한이고 수명도 넉넉하다.
      expect(await serveToken.needsRefill(machineId)).toBe(false);

      // 같은 토큰들이 리필 지평 안으로 들어오면, 개수는 그대로여도 가용분은 0이다.
      const nearExpiry =
        Date.now() + POLICY.serveToken.ttlMs - POLICY.serveToken.refillHorizonMs + 1000;
      expect(await serveToken.needsRefill(machineId, nearExpiry)).toBe(true);
    });

    it('prefetch-status는 canonical 캠페인 ID 헤더만 받는다', async () => {
      const { accessToken, machineId } = await signupWithMachine();
      const invalid = await prefetchStatus(accessToken, machineId)
        .set('x-clawad-campaign-ids', 'NOT-A-UUID')
        .expect(400);
      expect(invalid.body.error).toBe('INVALID_CACHED_CAMPAIGN_IDS');
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
