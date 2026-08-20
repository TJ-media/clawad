import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum InquiryStatus {
  /** 접수됨. 입금 확인 전이다. */
  RECEIVED = 'RECEIVED',
  /** 운영자가 입금을 확인했다. 아직 캠페인을 만들지 않았을 수 있다. */
  DEPOSIT_CONFIRMED = 'DEPOSIT_CONFIRMED',
  /** 캠페인이 만들어져 집행 중이다. */
  RUNNING = 'RUNNING',
  /** 예산을 전부 소진했다. */
  EXHAUSTED = 'EXHAUSTED',
  /** 입금이 오지 않았거나 광고주가 철회했다. */
  CANCELLED = 'CANCELLED',
}

export enum InquiryContactType {
  EMAIL = 'EMAIL',
  PHONE = 'PHONE',
}

/**
 * 광고 신청 접수 (CLAW-249). 소재 미리보기 화면에서 들어오는 집행 전 신청 기록이다.
 *
 * **4원장과 분리한다** (rules §4). 원장은 광고 이벤트·과금·리워드·지급을 담고, 이 테이블은
 * 그 앞단의 접수다. 입금을 확인해 캠페인을 만드는 시점에 비로소 원장이 생기며 `campaignId`로 잇는다.
 *
 * 비로그인 공개 폼이 쓰므로 계정과 연결되지 않는다. 광고주는 우리 서비스 계정이 없다.
 * `depositorName`·`contact`는 **광고주** 개인정보이며 이용자 이벤트 파이프라인과 무관한 별개
 * 데이터 주체다. 이벤트 원장과 조인하지 않고 **접속 IP 컬럼을 두지 않는다** (rules §6).
 * 레이트리밋은 Redis의 짧은 TTL 키로만 처리한다.
 */
@Entity('inquiries')
@Index(['status', 'createdAt'])
export class Inquiry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 광고 문구. 미리보기와 같은 상한(48자)으로 서버에서 다시 정화·검증한 값만 들어온다. */
  @Column({ type: 'varchar', length: 48 })
  creativeText: string;

  @Column({ type: 'varchar', length: 23 })
  brandName: string;

  /** 연결 링크(선택). https만 저장한다 — 클라이언트 검증 결과를 믿지 않고 서버가 다시 본다. */
  @Column({ type: 'varchar', length: 2048, nullable: true })
  linkUrl: string | null;

  @Column({ type: 'int' })
  depositAmountKrw: number;

  @Column({ type: 'varchar', length: 40 })
  depositorName: string;

  /** 집행 시작·소진 알림을 보낼 곳. 이메일 또는 국내 휴대전화 번호. */
  @Column({ type: 'varchar', length: 254 })
  contact: string;

  /** 서버가 `contact` 형식으로 재판정한다. 클라이언트가 보낸 값을 쓰지 않는다. */
  @Column({ type: 'enum', enum: InquiryContactType })
  contactType: InquiryContactType;

  @Column({ type: 'enum', enum: InquiryStatus, default: InquiryStatus.RECEIVED })
  status: InquiryStatus;

  /**
   * 접수 시점의 노출 1건당 단가. 정책값이 나중에 바뀌어도 **광고주가 보고 신청한 조건**이 남아야
   * 한다. 집행 예산 계산은 이 값으로 한다.
   */
  @Column({ type: 'int' })
  pricePerImpressionKrwAtReceipt: number;

  /** 입금 확인 후 만든 캠페인. 그 전에는 NULL이다. */
  @Column({ type: 'uuid', nullable: true })
  campaignId: string | null;

  /** 운영자 메모. 입금 대사 결과처럼 사람이 남기는 기록. */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
