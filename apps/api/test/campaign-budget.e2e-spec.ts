import './setup-env';
import { loginBootstrapAdmin } from './admin-helper';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AdDecisionService } from '../src/campaigns/ad-decision.service';
import { BudgetService } from '../src/campaigns/budget.service';
import { FrequencyService } from '../src/campaigns/frequency.service';
import { sanitizeCreativeText } from '../src/campaigns/campaigns.service';
import { loadPolicy } from '../src/common/policy';
import { BillingEntryType, BillingLedgerEntry } from '../src/entities/billing-ledger.entity';
import { CampaignStatus, CampaignType } from '../src/entities/campaign.entity';

let adminToken: string;
const POLICY = loadPolicy();

describe('CLAW-23 캠페인·크리에이티브·예산 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let budget: BudgetService;
  let decision: AdDecisionService;
  let frequency: FrequencyService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    adminToken = await loginBootstrapAdmin(app);
    budget = app.get(BudgetService);
    decision = app.get(AdDecisionService);
    frequency = app.get(FrequencyService);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const admin = (r: request.Test) => r.set('Authorization', `Bearer ${adminToken}`);

  const createAdvertiser = async (dailyImpressionLimit?: number) => {
    const res = await admin(api().post('/internal/v1/advertisers')).send({
      name: `광고주-${randomUUID().slice(0, 8)}`,
      ...(dailyImpressionLimit ? { dailyImpressionLimit } : {}),
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createCampaign = async (advertiserId: string, type: CampaignType, price: number, extra: object = {}) => {
    const res = await admin(api().post('/internal/v1/campaigns')).send({
      advertiserId,
      name: `캠페인-${randomUUID().slice(0, 8)}`,
      type,
      pricePerImpressionKrw: price,
      ...extra,
    });
    return res;
  };

  const transitionTo = (campaignId: string, to: CampaignStatus) =>
    admin(api().post(`/internal/v1/campaigns/${campaignId}/transition`)).send({ to }).expect(200);

  /** DRAFT → 소재 추가 → 소재 승인 → PENDING_REVIEW → APPROVED → ACTIVE */
  const activate = async (campaignId: string, text = '오늘의 개발자 할인') => {
    const cr = await admin(api().post(`/internal/v1/campaigns/${campaignId}/creatives`)).send({
      text,
      brand: '테스트브랜드',
    });
    expect(cr.status).toBe(201);
    await admin(api().post(`/internal/v1/creatives/${cr.body.id}/review`)).send({ approve: true }).expect(200);
    await transitionTo(campaignId, CampaignStatus.PENDING_REVIEW);
    await transitionTo(campaignId, CampaignStatus.APPROVED);
    await transitionTo(campaignId, CampaignStatus.ACTIVE);
    return cr.body.id as string;
  };

  const deposit = (campaignId: string, amountKrw: number) =>
    admin(api().post(`/internal/v1/campaigns/${campaignId}/budget/credit`))
      .send({ entryType: BillingEntryType.DEPOSIT, amountKrw })
      .expect(201);

  describe('관리자 인증', () => {
    it('토큰 없이 내부 API 호출 시 401', async () => {
      await api().post('/internal/v1/advertisers').send({ name: 'x' }).expect(401);
    });
    it('잘못된 토큰은 401', async () => {
      await api()
        .post('/internal/v1/advertisers')
        .set('Authorization', 'Bearer not-a-valid-jwt')
        .send({ name: 'x' })
        .expect(401);
    });
  });

  describe('캠페인 상태 전이 — 등록 즉시 노출 불가', () => {
    it('DRAFT에서 바로 ACTIVE로 갈 수 없다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      const res = await admin(api().post(`/internal/v1/campaigns/${c.body.id}/transition`)).send({
        to: CampaignStatus.ACTIVE,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ILLEGAL_TRANSITION');
    });

    it('승인된 소재가 없으면 ACTIVE로 갈 수 없다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      const id = c.body.id;
      // 소재는 있지만 심사 승인을 받지 않았다.
      await admin(api().post(`/internal/v1/campaigns/${id}/creatives`)).send({ text: '문구', brand: 'B' }).expect(201);
      await transitionTo(id, CampaignStatus.PENDING_REVIEW);
      await transitionTo(id, CampaignStatus.APPROVED);
      const res = await admin(api().post(`/internal/v1/campaigns/${id}/transition`)).send({ to: CampaignStatus.ACTIVE });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NO_APPROVED_CREATIVE');
    });

    it('미승인 캠페인은 ad-decision에 나오지 않는다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      await deposit(c.body.id, 100000);
      const d = await decision.decide(randomUUID());
      expect(d?.campaignId).not.toBe(c.body.id);
    });
  });

  describe('캠페인 유형 불변식', () => {
    it('HOUSE·TEST는 단가가 0이어야 한다', async () => {
      const adv = await createAdvertiser();
      const res = await createCampaign(adv, CampaignType.HOUSE, 5);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NON_PAID_CAMPAIGN_MUST_HAVE_ZERO_PRICE');
    });

    it('TEST는 rewardPolicyId를 가질 수 없다', async () => {
      const adv = await createAdvertiser();
      const res = await createCampaign(adv, CampaignType.TEST, 0, { rewardPolicyId: 'promo-1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('TEST_CAMPAIGN_CANNOT_HAVE_REWARD_POLICY');
    });

    it('HOUSE·TEST는 예산 원장을 만들 수 없다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.HOUSE, 0);
      const res = await admin(api().post(`/internal/v1/campaigns/${c.body.id}/budget/credit`)).send({
        entryType: BillingEntryType.DEPOSIT,
        amountKrw: 1000,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NOT_BILLABLE');
    });
  });

  describe('크리에이티브 심사·버전', () => {
    it('제어문자를 제거하고 한 줄로 만든다', () => {
      const dirty = ['할인', String.fromCharCode(27), '[31m 이벤트', String.fromCharCode(10), '둘째줄'].join('');
      expect(sanitizeCreativeText(dirty)).toBe('할인 [31m 이벤트 둘째줄');
    });

    it('소재가 [광고] 표기를 흉내내면 거절한다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      const res = await admin(api().post(`/internal/v1/campaigns/${c.body.id}/creatives`)).send({
        text: '[광고] 우리 제품',
        brand: 'B',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('AD_LABEL_IS_SYSTEM_OWNED');
    });

    it('Claude 공식 메시지로 오인될 문구를 거절한다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      const res = await admin(api().post(`/internal/v1/campaigns/${c.body.id}/creatives`)).send({
        text: 'Claude가 추천하는 도구',
        brand: 'B',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('OFFICIAL_MESSAGE_IMPERSONATION');
    });

    it('소재를 바꾸면 새 버전이 생기고 캠페인이 재심사로 돌아간다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      const id = c.body.id;
      await activate(id, '첫 문구');

      const v2 = await admin(api().post(`/internal/v1/campaigns/${id}/creatives`)).send({
        text: '바뀐 문구',
        brand: 'B',
      });
      expect(v2.status).toBe(201);
      expect(v2.body.version).toBe(2);
      expect(v2.body.status).toBe('PENDING_REVIEW');

      const after = await admin(api().get(`/internal/v1/campaigns/${id}`)).expect(200);
      expect(after.body.status).toBe(CampaignStatus.PENDING_REVIEW);

      // 재심사 중인 캠페인은 노출되지 않는다.
      const d = await decision.decide(randomUUID());
      expect(d?.campaignId).not.toBe(id);
    });
  });

  describe('예산 — 예약 없이 확정 차감만', () => {
    it('가용 예산은 원장 합산이다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      await deposit(c.body.id, 1000);
      await admin(api().post(`/internal/v1/campaigns/${c.body.id}/budget/credit`))
        .send({ entryType: BillingEntryType.BONUS_CREDIT, amountKrw: 500 })
        .expect(201);
      const res = await admin(api().get(`/internal/v1/campaigns/${c.body.id}/budget`)).expect(200);
      expect(res.body.availableKrw).toBe(1500);
    });

    it('capture는 멱등이다 — 같은 키로 두 번 차감하지 않는다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      await deposit(c.body.id, 100);
      const key = randomUUID();

      const first = await budget.captureImpression(c.body.id, key);
      const second = await budget.captureImpression(c.body.id, key);

      expect(first).toEqual({ captured: true, amountKrw: 2, idempotent: false });
      expect(second).toEqual({ captured: true, amountKrw: 2, idempotent: true });
      expect(await budget.availableKrw(c.body.id)).toBe(98);
    });

    it('예산을 초과 집행하지 않는다 — 동시 capture 20건, 예산은 10건분', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      await deposit(c.body.id, 20); // 2원 × 10건

      const results = await Promise.all(
        Array.from({ length: 20 }, () => budget.captureImpression(c.body.id, randomUUID())),
      );
      const captured = results.filter((r) => r.captured);
      const exhausted = results.filter((r) => !r.captured && r.reason === 'BUDGET_EXHAUSTED');

      expect(captured).toHaveLength(10);
      expect(exhausted).toHaveLength(10);
      expect(await budget.availableKrw(c.body.id)).toBe(0);
    });

    it('예산 소진은 BUDGET_EXHAUSTED이며 원장 행을 만들지 않는다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      await deposit(c.body.id, 2);
      await budget.captureImpression(c.body.id, randomUUID());

      const before = await dataSource.getRepository(BillingLedgerEntry).count({ where: { campaignId: c.body.id } });
      const res = await budget.captureImpression(c.body.id, randomUUID());
      const after = await dataSource.getRepository(BillingLedgerEntry).count({ where: { campaignId: c.body.id } });

      expect(res).toEqual({ captured: false, reason: 'BUDGET_EXHAUSTED', availableKrw: 0, requiredKrw: 2 });
      expect(after).toBe(before); // 원장에 아무 것도 append하지 않았다
    });

    it('HOUSE 캠페인은 capture하지 않는다 (NOT_BILLABLE)', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.HOUSE, 0);
      const res = await budget.captureImpression(c.body.id, randomUUID());
      expect(res).toEqual({ captured: false, reason: 'NOT_BILLABLE' });
    });

    it('알파에서 RESERVE·RELEASE 항목은 만들 수 없다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      for (const entryType of [BillingEntryType.RESERVE, BillingEntryType.RELEASE]) {
        const res = await admin(api().post(`/internal/v1/campaigns/${c.body.id}/budget/credit`)).send({
          entryType,
          amountKrw: 10,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('ENTRY_TYPE_NOT_ALLOWED_IN_ALPHA');
      }
    });

    it('원장은 append-only — DB가 UPDATE·DELETE를 거부한다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      await deposit(c.body.id, 10);
      const row = await dataSource.getRepository(BillingLedgerEntry).findOneByOrFail({ campaignId: c.body.id });

      await expect(
        dataSource.query(`UPDATE billing_ledger SET "amountKrw" = 999 WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/append-only/);
      await expect(dataSource.query(`DELETE FROM billing_ledger WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
    });

    it('사후 부정 판정은 반대 분개(IVT_REFUND)로 복원한다', async () => {
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      await deposit(c.body.id, 10);
      await budget.captureImpression(c.body.id, randomUUID());
      expect(await budget.availableKrw(c.body.id)).toBe(8);

      await budget.ivtRefund(c.body.id, 2, 'IVT');
      expect(await budget.availableKrw(c.body.id)).toBe(10);
    });
  });

  describe('ad-decision — 제외와 폴백', () => {
    // decide()는 서빙 가능한 모든 캠페인을 훑는다. 앞선 테스트가 남긴 ACTIVE 캠페인이
    // 결정에 끼어들지 않도록 각 테스트 시작 시 서빙 풀을 비운다.
    beforeEach(async () => {
      await dataSource.query(`UPDATE campaigns SET status = 'ENDED' WHERE status = 'ACTIVE'`);
    });

    it('예산 헤드룸이 부족한 PAID는 제외되고 HOUSE로 폴백한다', async () => {
      const userId = randomUUID();
      const adv = await createAdvertiser();

      const paid = await createCampaign(adv, CampaignType.PAID, 2);
      await activate(paid.body.id, '유료 광고');
      // 헤드룸 = 단가 2 × 미사용 토큰 3 = 6원. 4원만 넣어 부족하게 만든다.
      await deposit(paid.body.id, 4);
      expect(POLICY.serveToken.maxUnusedTokensPerMachine).toBe(3);

      const house = await createCampaign(adv, CampaignType.HOUSE, 0);
      await activate(house.body.id, '하우스 광고');

      const d = await decision.decide(userId);
      expect(d).not.toBeNull();
      expect(d!.campaignType).toBe(CampaignType.HOUSE);
      expect(d!.pricePerImpressionKrw).toBe(0);
    });

    it('헤드룸이 충분하면 PAID를 고른다', async () => {
      const userId = randomUUID();
      const adv = await createAdvertiser();
      const paid = await createCampaign(adv, CampaignType.PAID, 2);
      await activate(paid.body.id, '유료 광고 2');
      await deposit(paid.body.id, 100000);

      const d = await decision.decide(userId);
      expect(d!.campaignType).toBe(CampaignType.PAID);
      expect(d!.pricePerImpressionKrw).toBe(2);
    });

    it('같은 크리에이티브는 최소 간격 이내에 다시 나오지 않는다', async () => {
      const userId = randomUUID();
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      const creativeId = await activate(c.body.id, '간격 테스트');
      await deposit(c.body.id, 100000);

      expect((await decision.decide(userId))!.creativeId).toBe(creativeId);

      await frequency.recordAcceptedImpression(userId, adv, c.body.id, creativeId);
      expect(await frequency.isCreativeTooSoon(userId, creativeId)).toBe(true);

      // 최소 간격을 넘긴 시점에는 다시 노출 가능
      const later = new Date(Date.now() + POLICY.frequency.sameCreativeMinIntervalMs + 1000);
      expect(await frequency.isCreativeTooSoon(userId, creativeId, later)).toBe(false);
    });

    it('캠페인 일일 상한에 도달하면 제외된다', async () => {
      const userId = randomUUID();
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.PAID, 2);
      const creativeId = await activate(c.body.id, '상한 테스트');
      await deposit(c.body.id, 100000);

      for (let i = 0; i < POLICY.frequency.perCampaignDailyImpressionLimit; i++) {
        await frequency.recordAcceptedImpression(userId, adv, c.body.id, creativeId);
      }
      expect(await frequency.isCampaignCapReached(userId, c.body.id)).toBe(true);

      const d = await decision.decide(userId);
      expect(d?.campaignId).not.toBe(c.body.id);
    });

    it('종료된 캠페인은 제외된다', async () => {
      const userId = randomUUID();
      const adv = await createAdvertiser();
      const past = new Date(Date.now() - 60_000);
      const c = await createCampaign(adv, CampaignType.PAID, 2, { endsAt: past.toISOString() });
      await activate(c.body.id, '기간 만료');
      await deposit(c.body.id, 100000);

      const d = await decision.decide(userId);
      expect(d?.campaignId).not.toBe(c.body.id);
    });

    it('TEST 캠페인은 결정에 나오지 않는다', async () => {
      const userId = randomUUID();
      const adv = await createAdvertiser();
      const c = await createCampaign(adv, CampaignType.TEST, 0);
      await activate(c.body.id, '테스트 광고');

      const d = await decision.decide(userId);
      expect(d?.campaignId).not.toBe(c.body.id);
    });
  });
});
