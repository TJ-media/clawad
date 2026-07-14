import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 사용자 리워드 원장 항목 유형 (CLAW-17, CLAW-5). 전부 append-only.
 * 잔액은 합산으로만 계산한다 — balance 컬럼을 두지 않는다 (rules §4).
 */
export enum RewardEntryType {
  /** 검증 중. 인정 노출을 적립 예정으로 잡는다. */
  ACCRUE_PENDING = 'ACCRUE_PENDING',
  /** 확정 리워드. 사후 부정 검수를 통과한 pending을 확정한다. */
  ACCRUE_CONFIRM = 'ACCRUE_CONFIRM',
  /** 회수. 사후 부정 판정 시 반대 분개. */
  CLAW_BACK = 'CLAW_BACK',
  /** 교환 차감. 실제 교환은 CLAW-26에서 구현한다(enum만 정의). */
  REDEEM_DEBIT = 'REDEEM_DEBIT',
  /** 운영자 조정. */
  ADMIN_ADJUST = 'ADMIN_ADJUST',
  /** 동시 노출 승자 재투영의 비제재 반대 분개. 부호는 승격·강등 방향을 따른다. */
  REPROJECTION_ADJUST = 'REPROJECTION_ADJUST',
}

/** 리워드 재원. BUDGET_EXHAUSTED로 과금 없이 적립된 건은 회사 재원이다. */
export enum RewardFunding {
  ADVERTISER = 'ADVERTISER',
  COMPANY = 'COMPANY',
}

/**
 * append-only. 세율·과세 기준을 두지 않는다 (CLAW-13 미확정). 세무 상태 필드는 지급 원장(CLAW-26).
 * 접속 IP·하드웨어 식별자 컬럼을 두지 않는다 (privacy-design.md §2).
 */
@Entity('reward_ledger')
@Index(['userId', 'entryType'])
export class RewardLedgerEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: RewardEntryType })
  entryType: RewardEntryType;

  /** 부호 있는 정수(P). CLAW_BACK·REDEEM_DEBIT는 음수. */
  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  points: number;

  /**
   * 근거 노출의 멱등 키(impression_events.idempotencyKey).
   * ACCRUE_PENDING은 노출 1건당 1행이며 여기에 UNIQUE를 걸어 중복 적립을 막는다.
   * ACCRUE_CONFIRM/CLAW_BACK은 대상 pending과 같은 ref를 쓰되 유형이 다르므로 복합 유니크로 구분한다.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  refIdempotencyKey: string | null;

  @Column({ type: 'enum', enum: RewardFunding, nullable: true })
  funding: RewardFunding | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
