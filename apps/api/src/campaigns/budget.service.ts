import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  ALPHA_ALLOWED_ENTRY_TYPES,
  BillingEntryType,
  BillingLedgerEntry,
} from '../entities/billing-ledger.entity';
import { Campaign, CampaignType } from '../entities/campaign.entity';

export type CaptureResult =
  | { captured: true; amountKrw: number; idempotent: boolean }
  /**
   * 예산 소진. 사용자가 이미 광고를 유효하게 표시한 뒤일 수 있다.
   * 이 손실은 사용자에게 전가하지 않는다 — 광고주 과금 없이, 사용자 리워드는 회사 재원으로 적립한다
   * (invalid-traffic-policy.md §3-1). 부정행위 신호가 아니다.
   */
  | { captured: false; reason: 'BUDGET_EXHAUSTED'; availableKrw: number; requiredKrw: number }
  /** HOUSE·TEST는 과금 원장을 만들지 않는다. */
  | { captured: false; reason: 'NOT_BILLABLE' };

export interface BillingPolicySnapshot {
  policySnapshotId: string;
  policyVersion: number;
  rewardPolicyId: string | null;
  billingEligible: boolean;
  pricePerImpressionKrw: number;
}

@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** 가용 예산 = SUM(amountKrw). 잔액 컬럼을 따로 두지 않는다 (rules §4: balance 직접 수정 금지). */
  async availableKrw(campaignId: string, manager?: EntityManager): Promise<number> {
    const m = manager ?? this.dataSource.manager;
    const row = await m
      .createQueryBuilder(BillingLedgerEntry, 'e')
      .select('COALESCE(SUM(e.amountKrw), 0)', 'sum')
      .where('e.campaignId = :campaignId', { campaignId })
      .getRawOne<{ sum: string }>();
    return Number(row?.sum ?? 0);
  }

  /** 예산 충전·보너스·환급 등 (+) 항목. 운영자 콘솔에서 호출한다. */
  async credit(
    campaignId: string,
    entryType: BillingEntryType,
    amountKrw: number,
    reason?: string,
  ): Promise<BillingLedgerEntry> {
    if (!ALPHA_ALLOWED_ENTRY_TYPES.includes(entryType)) {
      throw new BadRequestException({ error: 'ENTRY_TYPE_NOT_ALLOWED_IN_ALPHA', entryType });
    }
    if (entryType === BillingEntryType.CAPTURE) {
      throw new BadRequestException({ error: 'USE_CAPTURE_IMPRESSION' });
    }
    if (!Number.isInteger(amountKrw) || amountKrw <= 0) {
      throw new BadRequestException({ error: 'AMOUNT_MUST_BE_POSITIVE_INTEGER' });
    }

    const campaign = await this.dataSource.getRepository(Campaign).findOneByOrFail({ id: campaignId });
    this.assertBillable(campaign);

    return this.dataSource.getRepository(BillingLedgerEntry).save(
      this.dataSource.getRepository(BillingLedgerEntry).create({
        advertiserId: campaign.advertiserId,
        campaignId,
        entryType,
        amountKrw,
        reason: reason ?? null,
      }),
    );
  }

  private assertBillable(campaign: Campaign): void {
    if (campaign.type !== CampaignType.PAID) {
      throw new BadRequestException({ error: 'NOT_BILLABLE', campaignType: campaign.type });
    }
  }

  /**
   * 노출 승인 시 확정 차감. 예약을 사용하지 않으므로 여기서 처음이자 마지막으로 예산을 건드린다.
   *
   * - 캠페인 행을 잠근 뒤 원장을 합산해 초과 집행을 막는다.
   * - 멱등 키가 이미 있으면 추가 과금 없이 기존 결과를 반환한다.
   * - HOUSE·TEST는 원장 행을 만들지 않는다.
   */
  async captureImpression(campaignId: string, idempotencyKey: string): Promise<CaptureResult> {
    if (!idempotencyKey) throw new BadRequestException({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.dataSource.transaction((manager) => this.captureWithManager(manager, campaignId, idempotencyKey));
  }

  /**
   * 제공된 트랜잭션 안에서 확정 차감한다. CLAW-6 파이프라인이 계정 advisory 잠금 트랜잭션
   * 안에서 호출한다 — 중첩 트랜잭션으로 잠금을 우회하지 않기 위함.
   * 캠페인 행을 잠근 뒤 원장을 합산해 초과 집행을 막는다.
   */
  async captureWithManager(
    manager: EntityManager,
    campaignId: string,
    idempotencyKey: string,
    policySnapshot?: BillingPolicySnapshot,
  ): Promise<CaptureResult> {
    const campaign = await manager.findOne(Campaign, {
      where: { id: campaignId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!campaign) throw new BadRequestException({ error: 'CAMPAIGN_NOT_FOUND' });

    if (!(policySnapshot?.billingEligible ?? campaign.type === CampaignType.PAID)) {
      return { captured: false, reason: 'NOT_BILLABLE' };
    }

    const existing = await manager.findOne(BillingLedgerEntry, { where: { idempotencyKey } });
    if (existing) {
      // 멱등: 같은 노출로 두 번 과금하지 않는다.
      return { captured: true, amountKrw: Math.abs(existing.amountKrw), idempotent: true };
    }

    const required = policySnapshot?.pricePerImpressionKrw ?? campaign.pricePerImpressionKrw;
    const available = await this.availableKrw(campaignId, manager);
    if (available < required) {
      // 사용자가 이미 광고를 봤을 수 있다. 사용자에게 전가하지 않는다 — 호출자(CLAW-6)가
      // billingEligible=false, 리워드는 회사 재원으로 처리한다.
      this.logger.warn(`BUDGET_EXHAUSTED: campaign=${campaignId} available=${available} required=${required}`);
      return { captured: false, reason: 'BUDGET_EXHAUSTED', availableKrw: available, requiredKrw: required };
    }

    await manager.save(
      manager.create(BillingLedgerEntry, {
        advertiserId: campaign.advertiserId,
        campaignId,
        entryType: BillingEntryType.CAPTURE,
        amountKrw: -required, // 차감은 음수 append. 잔액 컬럼을 수정하지 않는다.
        idempotencyKey,
        policySnapshotId: policySnapshot?.policySnapshotId ?? null,
        policyVersion: policySnapshot?.policyVersion ?? null,
        rewardPolicyId: policySnapshot?.rewardPolicyId ?? null,
        unitPriceKrw: policySnapshot?.pricePerImpressionKrw ?? null,
      }),
    );

    return { captured: true, amountKrw: required, idempotent: false };
  }

  /** 사후 부정 판정 시 광고주 크레딧 복원. 반대 분개를 append한다 (CLAW-19 §회수). */
  async ivtRefund(campaignId: string, amountKrw: number, reason: string): Promise<BillingLedgerEntry> {
    return this.credit(campaignId, BillingEntryType.IVT_REFUND, amountKrw, reason);
  }
}
