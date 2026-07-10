import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity';

export enum MachineStatus {
  ACTIVE = 'ACTIVE',
  RELEASED = 'RELEASED',
  BLOCKED = 'BLOCKED',
}

/**
 * 사용자 기기. machineId는 클라이언트가 로컬에서 난수로 생성한 가명값이며
 * MAC·디스크 시리얼·하드웨어 UUID가 아니다 (privacy-design.md §6).
 *
 * 상태는 전이로만 다룬다 — 행을 삭제하지 않는다. 해제는 RELEASED, 차단은 BLOCKED.
 * 서로 다른 계정이 같은 machineId를 쓰는 것은 MULTI_ACCOUNT_RISK 위험 신호일 뿐이며,
 * 자동 차단하지 않는다 (CLAW-19).
 */
@Entity('machines')
@Index(['userId', 'machineId'], { unique: true })
@Index(['machineId'])
export class Machine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, (user) => user.machines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /** 클라이언트 생성 가명 식별자. 32자리 소문자 hex (crypto.randomBytes(16)). */
  @Column({ type: 'varchar', length: 64 })
  machineId: string;

  @Column({ type: 'enum', enum: MachineStatus, default: MachineStatus.ACTIVE })
  status: MachineStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  blockedReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  registeredAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  blockedAt: Date | null;
}
