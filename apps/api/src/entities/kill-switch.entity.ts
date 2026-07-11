import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum KillSwitchTarget {
  MACHINE = 'MACHINE',
  USER = 'USER',
  CAMPAIGN = 'CAMPAIGN',
}

/**
 * 킬스위치 (CLAW-6, rules §7 서버 킬스위치 유지).
 * 대상(머신/회원/캠페인)을 즉시 수집 거부 목록에 올린다. 운영자가 켜고 끈다.
 * active=false 행도 남겨 이력으로 둔다.
 */
@Entity('kill_switches')
@Index(['target', 'targetId', 'active'])
export class KillSwitch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: KillSwitchTarget })
  target: KillSwitchTarget;

  /** MACHINE이면 machineId, USER면 userId(uuid 문자열), CAMPAIGN이면 campaignId. */
  @Column({ type: 'varchar', length: 64 })
  targetId: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
