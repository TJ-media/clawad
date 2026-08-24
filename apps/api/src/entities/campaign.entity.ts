import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Advertiser } from './advertiser.entity';
import { Creative } from './creative.entity';

/** 캠페인 유형별 과금·리워드 자격은 server/lib/campaign.js의 규칙과 동일하다 (CLAW-20). */
export enum CampaignType {
  PAID = 'PAID',
  HOUSE = 'HOUSE',
  TEST = 'TEST',
}

/**
 * 캠페인 상태 전이. 등록 즉시 노출되지 않는다 (CLAW-20).
 * DRAFT → PENDING_REVIEW → APPROVED → ACTIVE → PAUSED ⇄ ACTIVE → ENDED
 *                        ↘ REJECTED
 */
export enum CampaignStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  REJECTED = 'REJECTED',
  APPROVED = 'APPROVED',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ENDED = 'ENDED',
}

/** 노출 가능한 상태는 ACTIVE 하나뿐이다. */
export const SERVABLE_STATUSES: readonly CampaignStatus[] = [CampaignStatus.ACTIVE];

@Entity('campaigns')
@Index(['status'])
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  advertiserId: string;

  @ManyToOne(() => Advertiser, (a) => a.campaigns, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'advertiserId' })
  advertiser: Advertiser;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: CampaignType })
  type: CampaignType;

  @Column({ type: 'enum', enum: CampaignStatus, default: CampaignStatus.DRAFT })
  status: CampaignStatus;

  /** 노출 1건당 광고주 과금액(원). 정책의 CPM에서 산출해 캠페인 계약 시점에 고정한다. */
  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  pricePerImpressionKrw: number;

  /**
   * HOUSE 캠페인이 회사 재원으로 리워드를 적립할 때만 채운다 (CLAW-20 예외 경로).
   * 이 값이 없으면 HOUSE는 리워드를 만들지 않는다.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  rewardPolicyId: string | null;

  /**
   * HOUSE 리워드의 명시적 스위치 (CLAW-261). server/lib/campaign.js §eligibility의 2요인 —
   * 이 값과 rewardPolicyId가 **둘 다** 있어야 리워드 자격이 생긴다. 컬럼이 없던 동안 호출부가
   * Boolean(rewardPolicyId)로 합성해 조건이 단일 요인으로 무너져 있었다.
   */
  @Column({ type: 'boolean', default: false })
  houseRewardOptIn: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  startsAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endsAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reviewNote: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => Creative, (c) => c.campaign)
  creatives: Creative[];
}
