import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum ImpressionDecision {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

/**
 * 광고 이벤트 원장 (CLAW-17, CLAW-6). append-only.
 *
 * - 거절된 이벤트도 남긴다 — 수신 통계·무효 사유 분석에 필요하다 (CLAW-19).
 * - `CONCURRENT_USER_IMPRESSION`으로 거절된 것도 원장에 남기되 유효 노출·과금·리워드를 만들지 않는다.
 * - 접속 IP 컬럼을 두지 않는다. IP는 제품 이벤트 데이터가 아니다 (privacy-design.md §6.6).
 * - 금액을 직접 저장하지 않는다. 과금은 billing_ledger, 리워드는 reward_ledger(CLAW-5)가 원장으로 관리한다.
 */
@Entity('impression_events')
@Index(['userId', 'decision'])
@Index(['userId', 'receivedAt'])
@Index(['tokenJti'])
export class ImpressionEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  /** 서버 생성 멱등 키 SHA-256(tokenJti:machineId:sequence). 같은 노출을 두 번 집계하지 않는다. */
  @Column({ type: 'varchar', length: 128, unique: true })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 64 })
  tokenJti: string;

  @Column({ type: 'uuid' })
  campaignId: string;

  @Column({ type: 'varchar', length: 16 })
  campaignType: string;

  @Column({ type: 'uuid', nullable: true })
  policySnapshotId: string | null;

  @Column({ type: 'int', nullable: true })
  policyVersion: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  rewardPolicyId: string | null;

  @Column({ type: 'boolean', nullable: true })
  billingEligibleSnapshot: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  rewardEligibleSnapshot: boolean | null;

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => v == null ? null : Number(v) } })
  pricePerImpressionKrwSnapshot: number | null;

  @Column({ type: 'int', nullable: true })
  rewardPerThousandSnapshot: number | null;

  @Column({ type: 'int', nullable: true })
  minViewMsSnapshot: number | null;

  @Column({ type: 'int', nullable: true })
  concurrentToleranceMsSnapshot: number | null;

  @Column({ type: 'int', nullable: true })
  timeWindowToleranceMsSnapshot: number | null;

  @Column({ type: 'int', nullable: true })
  dailyAcceptedLimitSnapshot: number | null;

  @Column({ type: 'int', nullable: true })
  dailyRewardLimitSnapshot: number | null;

  @Column({ type: 'int', nullable: true })
  campaignDailyLimitSnapshot: number | null;

  @Column({ type: 'int', nullable: true })
  advertiserDailyLimitSnapshot: number | null;

  @Column({ type: 'uuid', nullable: true })
  creativeId: string | null;

  /** 서버가 인증 세션·토큰으로 확정한 사용자. 이벤트 본문의 자가신고값이 아니다. */
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 64 })
  machineId: string;

  @Column({ type: 'int' })
  sequence: number;

  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  startedAt: number;

  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  endedAt: number;

  @Column({ type: 'enum', enum: ImpressionDecision })
  decision: ImpressionDecision;

  /** 거절 사유 코드(invalid-traffic-policy.md §7). ACCEPTED면 null. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  reason: string | null;

  /** 광고주 과금이 실제로 발생했는가. BUDGET_EXHAUSTED면 ACCEPTED이지만 billed=false. */
  @Column({ type: 'boolean', default: false })
  billed: boolean;

  /** 리워드 '검증 중'으로 표시될 자격. 실제 리워드 원장 기록은 CLAW-5. */
  @Column({ type: 'boolean', default: false })
  rewardEligible: boolean;

  /** 회사 재원 리워드 여부. BUDGET_EXHAUSTED로 과금 없이 리워드가 붙는 경우 true. */
  @Column({ type: 'boolean', default: false })
  companyFunded: boolean;

  @Column({ type: 'varchar', length: 32, nullable: true })
  clientVersion: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;
}
