import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum ReportStatus {
  /** 접수됨. 아직 답변하지 않았다. */
  OPEN = 'OPEN',
  /** 운영자가 답변했다. 포상은 선택이므로 답변만으로도 이 상태가 된다. */
  ANSWERED = 'ANSWERED',
}

/**
 * 이용자 제보 (CLAW-234). 버그·의견 접수와 운영자 답변, 선택적 포상 리워드를 담는다.
 *
 * 제보는 답변과 포상 지급 대상을 특정해야 하므로 계정과 연결해 저장한다. 익명 제보가 아니며
 * 제보 화면에서 그 사실을 고지한다. 광고 노출 이벤트 원장(impression_events)과 조인하지 않고,
 * 접속 IP·하드웨어 식별자 컬럼을 두지 않는다 (privacy-design.md §2·§6.6).
 *
 * 수집 항목·목적·보유기간은 privacy-design.md §1.5.3과 처리방침 v4 제1장 다-2.에 있다.
 * **이메일 필드는 처리방침 v4가 게시된 뒤에만 채운다.**
 */
@Entity('reports')
@Index(['userId', 'createdAt'])
@Index(['status', 'createdAt'])
export class Report {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  /** 이용자가 직접 작성한 본문. 제어문자를 제거하고 정책 상한을 넘으면 거절된 값만 들어온다. */
  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'enum', enum: ReportStatus, default: ReportStatus.OPEN })
  status: ReportStatus;

  /**
   * 답변 회신용 이메일 (선택, CLAW-233). 이 제보 한 건의 스냅샷이며 users.email은 계속 NULL이다 —
   * 쿠폰 발송 이메일(redemptions.deliveryEmail, CLAW-74)과 같은 틀이다.
   * 답변 완료·종결 시 NULL로 파기하고 동의 시각만 증적으로 남긴다.
   */
  @Column({ type: 'varchar', length: 254, nullable: true })
  replyEmail: string | null;

  /** 위 이메일의 수집·이용 동의 시각. 이메일을 파기해도 동의 증적으로 유지한다. */
  @Column({ type: 'timestamptz', nullable: true })
  replyEmailConsentAt: Date | null;

  /** 운영자 답변 본문. */
  @Column({ type: 'text', nullable: true })
  reply: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  repliedAt: Date | null;

  /**
   * 포상 포인트. **운영자가 건별로 정한다** — 정책은 상한(bugReport.maxRewardPoints)만 강제한다.
   * 실제 잔액은 여기가 아니라 reward_ledger 합산이 정한다 (rules §4). 이 값은 표시·감사용 사본이다.
   */
  @Column({ type: 'int', default: 0 })
  rewardPoints: number;

  /** 사용자가 답변을 읽은 시각. 안 읽은 답변 알림의 기준이며 기기가 바뀌어도 유지된다. */
  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
