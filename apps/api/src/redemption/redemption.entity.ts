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
 *
 * 발송 이메일(deliveryEmail, CLAW-74): 알파 쿠폰 수동 발송을 위해 사용자가 교환 시 입력·동의한 주소의
 * 스냅샷이다. 이 한 건의 발송 목적으로만 쓰며, 로그인 식별자로 쓰지 않는다(users.email은 계속 NULL).
 * 전화번호 등 다른 수신정보는 저장하지 않는다. 탈퇴·파기 시 이 컬럼도 함께 파기한다(privacy.service).
 */
@Entity('redemptions')
@Index(['userId'])
@Index(['status'])
// 교환 의도별 멱등 키. 같은 사용자·같은 키의 재시도가 새 주문·추가 차감을 만들지 않게 한다 (CLAW-73).
// 키 도입 이전 레거시 행은 NULL이므로 부분 유니크로 NULL 다중을 허용한다.
@Index(['userId', 'idempotencyKey'], { unique: true, where: '"idempotencyKey" IS NOT NULL' })
export class Redemption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  productId: string;

  /** 클라이언트가 교환 의도별로 생성한 UUID. 미전송(레거시·CLI) 요청은 NULL — 멱등 보장 없음. */
  @Column({ type: 'uuid', nullable: true })
  idempotencyKey: string | null;

  /**
   * 쿠폰을 보낼 발송 이메일 스냅샷 (CLAW-74). 사용자가 교환 시 입력·확인·동의한 값.
   * 레거시·미입력 교환은 NULL. 운영자에게 노출할 때는 마스킹하며, 정확한 발송 주소는 감사 기록되는
   * reveal 액션으로만 확인한다. 애플리케이션 로그에 원문을 남기지 않는다.
   * 발송·취소·실패로 종결되면(또는 탈퇴 시) 즉시 NULL로 파기해 보유를 최소화한다.
   */
  @Column({ type: 'varchar', length: 320, nullable: true })
  deliveryEmail: string | null;

  /**
   * 발송 이메일 수집·이용 동의 시각 (CLAW-74). 동의 없이는 교환이 생성되지 않으므로 동의 증적이다.
   * 이메일 원문을 파기해도 이 시각은 유지해 "동의가 있었음"을 입증한다(시각은 식별정보 아님).
   */
  @Column({ type: 'timestamptz', nullable: true })
  deliveryEmailConsentAt: Date | null;

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
