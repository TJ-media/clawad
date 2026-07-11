import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 교환(지급) 상태. 알파는 운영자 수동 발송이라 SUPPLIER_ORDER(벤더 주문)는 정의만 하고 쓰지 않는다.
 * REQUESTED → DELIVERED(수동 발송 완료) / DELIVERY_FAILED / CANCELED.
 */
export enum RedemptionStatus {
  REQUESTED = 'REQUESTED',
  /** 미사용 (알파). 벤더 API 연동 시 사용. */
  SUPPLIER_ORDERED = 'SUPPLIER_ORDERED',
  DELIVERED = 'DELIVERED',
  DELIVERY_FAILED = 'DELIVERY_FAILED',
  CANCELED = 'CANCELED',
}

/**
 * 세무 처리 상태 필드만 둔다. 세율·과세 기준은 하드코딩하지 않는다 (CLAW-13 미확정, rules §5).
 */
export enum RedemptionTaxStatus {
  NONE = 'NONE',
  WITHHOLDING_PENDING = 'WITHHOLDING_PENDING',
  WITHHOLDING_DONE = 'WITHHOLDING_DONE',
  REPORTED = 'REPORTED',
}

/**
 * 교환 요청 (CLAW-26). 상태는 mutable 프로젝션이며, 상태 전이 이력은 redemption_ledger(append-only)에 남는다.
 * 포인트 차감·원복은 reward_ledger(append-only)로만 이뤄진다 — 여기에 잔액을 두지 않는다.
 * 쿠폰 수신정보(전화번호 등)는 저장하지 않는다. 수동 발송은 운영자가 별도 채널로 처리한다(개인정보 최소화).
 */
@Entity('redemptions')
@Index(['userId'])
@Index(['status'])
export class Redemption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  productId: string;

  /** 차감된 확정 포인트. 상품 pointCost의 스냅샷(상품 가격이 나중에 바뀌어도 이 교환은 불변). */
  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  pointsDebited: number;

  @Column({ type: 'enum', enum: RedemptionStatus, default: RedemptionStatus.REQUESTED })
  status: RedemptionStatus;

  @Column({ type: 'enum', enum: RedemptionTaxStatus, default: RedemptionTaxStatus.NONE })
  taxStatus: RedemptionTaxStatus;

  /** 운영자 수동 발송 참조 메모(주문번호 등). 쿠폰 코드 원문·수신 연락처는 넣지 않는다. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  supplierRef: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
