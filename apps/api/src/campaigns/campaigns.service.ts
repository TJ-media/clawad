import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Advertiser } from '../entities/advertiser.entity';
import { Campaign, CampaignStatus, CampaignType } from '../entities/campaign.entity';
import { Creative, CreativeStatus } from '../entities/creative.entity';

/** 허용된 상태 전이만 수행한다. 등록 즉시 노출되지 않는다 (CLAW-20). */
const ALLOWED_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  [CampaignStatus.DRAFT]: [CampaignStatus.PENDING_REVIEW],
  [CampaignStatus.PENDING_REVIEW]: [CampaignStatus.APPROVED, CampaignStatus.REJECTED],
  [CampaignStatus.REJECTED]: [CampaignStatus.PENDING_REVIEW],
  [CampaignStatus.APPROVED]: [CampaignStatus.ACTIVE, CampaignStatus.ENDED],
  [CampaignStatus.ACTIVE]: [CampaignStatus.PAUSED, CampaignStatus.ENDED],
  [CampaignStatus.PAUSED]: [CampaignStatus.ACTIVE, CampaignStatus.ENDED],
  [CampaignStatus.ENDED]: [],
};

/**
 * 소재 문구 정화: 개행·ANSI/OSC 등 제어문자를 제거하고 한 줄로 만든다 (CLAW-20 §공통 심사).
 * C0(U+0000–U+001F), DEL(U+007F), C1(U+0080–U+009F)을 공백으로 바꾼 뒤 공백을 접는다.
 * 상태줄은 정확히 한 줄이므로 제어문자가 남으면 렌더링이 깨지거나 위조될 수 있다.
 */
export function sanitizeCreativeText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `[광고]` 표기는 시스템이 노출 시점에 부착한다. 소재가 스스로 붙이거나 흉내내지 못하게 막는다. */
export function assertNoAdLabelSpoofing(text: string): void {
  if (/\[\s*광고\s*\]|\[\s*AD\s*\]/i.test(text)) {
    throw new BadRequestException({ error: 'AD_LABEL_IS_SYSTEM_OWNED' });
  }
  if (/claude|anthropic/i.test(text)) {
    throw new BadRequestException({ error: 'OFFICIAL_MESSAGE_IMPERSONATION' });
  }
}

@Injectable()
export class CampaignsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  createAdvertiser(name: string, dailyImpressionLimit: number | null): Promise<Advertiser> {
    const repo = this.dataSource.getRepository(Advertiser);
    return repo.save(repo.create({ name, dailyImpressionLimit }));
  }

  async createCampaign(input: {
    advertiserId: string;
    name: string;
    type: CampaignType;
    pricePerImpressionKrw: number;
    rewardPolicyId?: string | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
  }): Promise<Campaign> {
    const advertiser = await this.dataSource.getRepository(Advertiser).findOneBy({ id: input.advertiserId });
    if (!advertiser) throw new NotFoundException({ error: 'ADVERTISER_NOT_FOUND' });

    // HOUSE는 명시적 재원 정책(rewardPolicyId)이 있을 때만 리워드를 만든다. TEST는 어떤 경우에도 만들지 않는다.
    if (input.type === CampaignType.TEST && input.rewardPolicyId) {
      throw new BadRequestException({ error: 'TEST_CAMPAIGN_CANNOT_HAVE_REWARD_POLICY' });
    }
    if (input.type !== CampaignType.PAID && input.pricePerImpressionKrw !== 0) {
      throw new BadRequestException({ error: 'NON_PAID_CAMPAIGN_MUST_HAVE_ZERO_PRICE' });
    }

    const repo = this.dataSource.getRepository(Campaign);
    return repo.save(
      repo.create({
        advertiserId: input.advertiserId,
        name: input.name,
        type: input.type,
        pricePerImpressionKrw: input.pricePerImpressionKrw,
        rewardPolicyId: input.rewardPolicyId ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        status: CampaignStatus.DRAFT,
      }),
    );
  }

  async transition(campaignId: string, to: CampaignStatus, reviewNote?: string): Promise<Campaign> {
    return this.dataSource.transaction(async (manager) => {
      const campaign = await manager.findOne(Campaign, {
        where: { id: campaignId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!campaign) throw new NotFoundException({ error: 'CAMPAIGN_NOT_FOUND' });

      if (!ALLOWED_TRANSITIONS[campaign.status].includes(to)) {
        throw new BadRequestException({ error: 'ILLEGAL_TRANSITION', from: campaign.status, to });
      }

      // 승인된 소재가 하나도 없으면 활성화할 수 없다 — 등록 즉시 노출 금지의 마지막 방어선.
      if (to === CampaignStatus.ACTIVE) {
        const approved = await manager.count(Creative, {
          where: { campaignId, status: CreativeStatus.APPROVED },
        });
        if (approved === 0) throw new BadRequestException({ error: 'NO_APPROVED_CREATIVE' });
      }

      campaign.status = to;
      campaign.reviewNote = reviewNote ?? campaign.reviewNote;
      return manager.save(campaign);
    });
  }

  /**
   * 소재 추가 또는 변경. 기존 행의 text를 수정하지 않고 새 버전을 append한다.
   * 새 버전은 항상 PENDING_REVIEW로 시작한다 — 변경 시 재심사 (CLAW-20).
   * 이전 APPROVED 버전은 SUPERSEDED로 전이해 더 이상 노출하지 않는다.
   */
  async addCreativeVersion(
    campaignId: string,
    input: { text: string; brand: string; landingUrl?: string | null },
  ): Promise<Creative> {
    const text = sanitizeCreativeText(input.text);
    assertNoAdLabelSpoofing(text);
    if (!text) throw new BadRequestException({ error: 'CREATIVE_TEXT_EMPTY' });

    return this.dataSource.transaction(async (manager) => {
      const campaign = await manager.findOne(Campaign, {
        where: { id: campaignId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!campaign) throw new NotFoundException({ error: 'CAMPAIGN_NOT_FOUND' });

      const latest = await manager.findOne(Creative, {
        where: { campaignId },
        order: { version: 'DESC' },
      });
      const nextVersion = (latest?.version ?? 0) + 1;

      if (latest?.status === CreativeStatus.APPROVED) {
        latest.status = CreativeStatus.SUPERSEDED;
        await manager.save(latest);
      }

      // 소재가 바뀌면 캠페인도 재심사로 되돌린다. 승인된 채로 새 문구가 나가지 않게 한다.
      if (campaign.status === CampaignStatus.ACTIVE || campaign.status === CampaignStatus.APPROVED) {
        campaign.status = CampaignStatus.PENDING_REVIEW;
        await manager.save(campaign);
      }

      return manager.save(
        manager.create(Creative, {
          campaignId,
          version: nextVersion,
          text,
          brand: input.brand,
          landingUrl: input.landingUrl ?? null,
          status: CreativeStatus.PENDING_REVIEW,
        }),
      );
    });
  }

  async reviewCreative(creativeId: string, approve: boolean, reviewNote?: string): Promise<Creative> {
    const repo = this.dataSource.getRepository(Creative);
    const creative = await repo.findOneBy({ id: creativeId });
    if (!creative) throw new NotFoundException({ error: 'CREATIVE_NOT_FOUND' });
    if (creative.status !== CreativeStatus.PENDING_REVIEW) {
      throw new BadRequestException({ error: 'CREATIVE_NOT_PENDING', status: creative.status });
    }
    creative.status = approve ? CreativeStatus.APPROVED : CreativeStatus.REJECTED;
    creative.reviewNote = reviewNote ?? null;
    return repo.save(creative);
  }

  get(campaignId: string): Promise<Campaign | null> {
    return this.dataSource.getRepository(Campaign).findOne({
      where: { id: campaignId },
      relations: { creatives: true },
    });
  }
}
