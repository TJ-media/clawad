import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 광고주 과금 원장 항목 유형.
 *
 * `RESERVE`/`RELEASE`는 정의만 해두고 **알파에서는 쓰지 않는다** (ledgers.md §예산 처리 방식).
 * 알파는 예약 원장을 사용하지 않는다 — 광고 결정은 가용성만 확인하고, 승인 시 CAPTURE만 append한다.
 * PAID 트래픽이 실제로 초과 집행을 일으키면 마이그레이션 없이 켤 수 있다.
 */
export enum BillingEntryType {
  DEPOSIT = 'DEPOSIT',
  BONUS_CREDIT = 'BONUS_CREDIT',
  CAPTURE = 'CAPTURE',
  REFUND = 'REFUND',
  IVT_REFUND = 'IVT_REFUND',
  /** 미사용 (알파). */
  RESERVE = 'RESERVE',
  /** 미사용 (알파). */
  RELEASE = 'RELEASE',
}

/** 알파에서 실제로 쓰는 유형. 이 외의 유형을 append하려 하면 서비스가 거부한다. */
export const ALPHA_ALLOWED_ENTRY_TYPES: readonly BillingEntryType[] = [
  BillingEntryType.DEPOSIT,
  BillingEntryType.BONUS_CREDIT,
  BillingEntryType.CAPTURE,
  BillingEntryType.REFUND,
  BillingEntryType.IVT_REFUND,
];

/**
 * append-only. 행을 수정·삭제하지 않는다. 정정은 반대 분개를 append한다 (CLAW-17).
 * 가용 예산 = SUM(amountKrw). DEPOSIT·BONUS_CREDIT·REFUND·IVT_REFUND는 (+), CAPTURE는 (−).
 *
 * HOUSE·TEST 캠페인은 이 원장에 행을 만들지 않는다 (billingEligible=false).
 */
@Entity('billing_ledger')
@Index(['campaignId'])
export class BillingLedgerEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  advertiserId: string;

  @Column({ type: 'uuid' })
  campaignId: string;

  @Column({ type: 'enum', enum: BillingEntryType })
  entryType: BillingEntryType;

  /** 부호 있는 정수(원). CAPTURE는 음수. */
  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  amountKrw: number;

  /**
   * 같은 노출로 두 번 과금하지 않기 위한 멱등 키.
   * 서버가 SHA-256(tokenJti:machineId:sequence)로 만든 값 (CLAW-18).
   */
  @Column({ type: 'varchar', length: 128, nullable: true, unique: true })
  idempotencyKey: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  policySnapshotId: string | null;

  @Column({ type: 'int', nullable: true })
  policyVersion: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  rewardPolicyId: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => v == null ? null : Number(v) } })
  unitPriceKrw: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
