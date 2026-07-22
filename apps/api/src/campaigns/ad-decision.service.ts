import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { loadPolicy } from '../common/policy';
import { Advertiser } from '../entities/advertiser.entity';
import { Campaign, CampaignStatus, CampaignType } from '../entities/campaign.entity';
import { Creative, CreativeStatus } from '../entities/creative.entity';
import { BudgetService } from './budget.service';
import { FrequencyService } from './frequency.service';

export interface AdDecision {
  campaignId: string;
  campaignType: CampaignType;
  creativeId: string;
  text: string;
  brand: string;
  landingUrl: string | null;
  /** PAID일 때 노출 1건당 과금액. HOUSE·TEST는 0. */
  pricePerImpressionKrw: number;
  rewardPolicyId: string | null;
  advertiserDailyImpressionLimit: number | null;
}

/**
 * 광고 결정 (CLAW-23 §예외: 예산 소진·만료·미승인 캠페인 자동 제외).
 *
 * **예산을 예약하지 않는다.** 여기서의 예산 검사는 조언적이며 원장 행을 만들지 않는다
 * (ledgers.md §예산 처리 방식). 확정 차감은 노출 승인 시 BudgetService.captureImpression이 한 번만 한다.
 *
 * serveToken 발급은 CLAW-24/CLAW-18 범위다. 이 서비스는 "무엇을 보여줄지"만 정한다.
 */
@Injectable()
export class AdDecisionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly budget: BudgetService,
    private readonly frequency: FrequencyService,
  ) {}

  /**
   * 헤드룸: 프리페치된 미사용 토큰이 전부 노출로 인정돼도 예산이 버티는가.
   * 예약을 쓰지 않으므로, 결정 단계에서 여유가 없는 캠페인은 아예 후보에서 뺀다.
   * 이렇게 해도 BUDGET_EXHAUSTED는 완전히 사라지지 않는다 — 그때의 손실은 회사가 부담한다.
   */
  private requiredHeadroomKrw(campaign: Campaign): number {
    const maxUnused = loadPolicy().serveToken.maxUnusedTokensPerMachine;
    return campaign.pricePerImpressionKrw * maxUnused;
  }

  private async servableCampaigns(now: Date, manager?: EntityManager): Promise<Campaign[]> {
    const repo = (manager ?? this.dataSource.manager).getRepository(Campaign);
    // 노출 가능한 상태는 ACTIVE 하나뿐. 승인 전·일시중지·종료 캠페인은 나오지 않는다.
    const active = await repo.find({ where: { status: CampaignStatus.ACTIVE } });
    return active.filter((c) => {
      if (c.startsAt && c.startsAt > now) return false;
      if (c.endsAt && c.endsAt <= now) return false;
      return true;
    });
  }

  private approvedCreative(campaignId: string, manager?: EntityManager): Promise<Creative | null> {
    return (manager ?? this.dataSource.manager).getRepository(Creative).findOne({
      where: { campaignId, status: CreativeStatus.APPROVED },
      order: { version: 'DESC' },
    });
  }

  private toDecision(campaign: Campaign, creative: Creative, advertiserDailyImpressionLimit: number | null): AdDecision {
    return {
      campaignId: campaign.id,
      campaignType: campaign.type,
      creativeId: creative.id,
      text: creative.text,
      brand: creative.brand,
      landingUrl: creative.landingUrl,
      pricePerImpressionKrw: campaign.type === CampaignType.PAID ? campaign.pricePerImpressionKrw : 0,
      rewardPolicyId: campaign.rewardPolicyId,
      advertiserDailyImpressionLimit,
    };
  }

  private async isEligible(
    userId: string,
    campaign: Campaign,
    creative: Creative,
    now: Date,
    manager?: EntityManager,
  ): Promise<boolean> {
    if (await this.frequency.isCampaignCapReached(userId, campaign.id, now)) return false;
    if (await this.frequency.isCreativeTooSoon(userId, creative.id, now)) return false;

    const advertiser = await (manager ?? this.dataSource.manager)
      .getRepository(Advertiser)
      .findOneBy({ id: campaign.advertiserId });
    if (!advertiser) return false;
    if (await this.frequency.isAdvertiserCapReached(userId, advertiser.id, advertiser.dailyImpressionLimit, now)) {
      return false;
    }

    if (campaign.type === CampaignType.PAID) {
      const available = await this.budget.availableKrw(campaign.id, manager);
      if (available < this.requiredHeadroomKrw(campaign)) return false;
    }
    return true;
  }

  /**
   * 기본은 PAID 후보를 먼저 고르고, 없으면 HOUSE로 폴백한다.
   * TEST는 서버 게이트와 명시적 리허설 헤더가 모두 있을 때 controller가 단독 유형으로 전달한다.
   *
   * 알파(캠페인 수십 개)에서는 후보를 순차 평가한다. 캠페인이 늘면 후보 선별을 SQL로 내리고
   * 빈도·예산 검사를 배치화해야 한다 — 알파 규모에서는 조기 최적화다.
   */
  async decide(
    userId: string,
    now = new Date(),
    excludedCampaignIds: ReadonlySet<string> = new Set(),
    manager?: EntityManager,
    campaignTypes: readonly CampaignType[] = [CampaignType.PAID, CampaignType.HOUSE],
  ): Promise<AdDecision | null> {
    const campaigns = (await this.servableCampaigns(now, manager)).filter(
      (campaign) => !excludedCampaignIds.has(campaign.id),
    );

    // 같은 사용자에게 가장 오래 노출되지 않은 캠페인을 먼저 시도한다 (CLAW-102).
    // 이 정렬이 없으면 항상 첫 번째 적격 캠페인만 반환되어, 클라이언트가 여러 번 요청해도
    // 프리페치 캐시가 단일 소재로 채워진다.
    const lastServed = await this.frequency.lastServedAt(userId, campaigns.map((c) => c.id));
    const byType = (type: CampaignType) =>
      campaigns
        .filter((c) => c.type === type)
        .sort((a, b) => (lastServed.get(a.id) ?? 0) - (lastServed.get(b.id) ?? 0));

    for (const type of campaignTypes) {
      for (const campaign of byType(type)) {
        const creative = await this.approvedCreative(campaign.id, manager);
        if (!creative) continue;
        if (await this.isEligible(userId, campaign, creative, now, manager)) {
          const advertiser = await (manager ?? this.dataSource.manager)
            .getRepository(Advertiser)
            .findOneByOrFail({ id: campaign.advertiserId });
          // 다음 요청이 다른 캠페인을 고르도록 서빙 시각을 남긴다. 실패해도 결정은 유효하다.
          await this.frequency.recordServe(userId, campaign.id, now).catch(() => undefined);
          return this.toDecision(campaign, creative, advertiser.dailyImpressionLimit);
        }
      }
    }
    return null;
  }
}
