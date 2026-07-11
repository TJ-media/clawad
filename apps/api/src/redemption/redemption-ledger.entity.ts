import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 지급 원장 (CLAW-17, CLAW-26). 교환 상태 전이를 불변으로 남긴다. append-only(DB 트리거).
 * CLAW-17 설계의 entry_type: request / supplier_order / delivered / delivery_failed / canceled / resent.
 */
export enum RedemptionEntryType {
  REQUEST = 'REQUEST',
  /** 미사용 (알파). 벤더 API 연동 시. */
  SUPPLIER_ORDER = 'SUPPLIER_ORDER',
  DELIVERED = 'DELIVERED',
  DELIVERY_FAILED = 'DELIVERY_FAILED',
  CANCELED = 'CANCELED',
  RESENT = 'RESENT',
}

@Entity('redemption_ledger')
@Index(['redemptionId'])
export class RedemptionLedgerEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  redemptionId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: RedemptionEntryType })
  entryType: RedemptionEntryType;

  @Column({ type: 'varchar', length: 200, nullable: true })
  detail: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
