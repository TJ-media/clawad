import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 파기 로그 (CLAW-28). 개인정보 파기·가명화 이력을 불변으로 남긴다.
 * append-only — DB 트리거로 UPDATE·DELETE 차단.
 *
 * userId는 가명 식별자다. 파기된 직접 식별자(이메일 등)를 여기에 복제하지 않는다.
 */
export enum DestructionAction {
  /** 탈퇴 시 직접 식별자 파기·가명화. */
  WITHDRAWAL = 'WITHDRAWAL',
  /** 보유기간 경과 데이터 파기 배치. */
  RETENTION_SWEEP = 'RETENTION_SWEEP',
}

@Entity('destruction_logs')
@Index(['userId'])
export class DestructionLog {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'enum', enum: DestructionAction })
  action: DestructionAction;

  /** 무엇을 파기·가명화했는지 요약(항목명). 파기된 값 자체는 남기지 않는다. */
  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
