import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum KillSwitchTarget {
  MACHINE = 'MACHINE',
  USER = 'USER',
  CAMPAIGN = 'CAMPAIGN',
  /** 전체 광고 발급·클릭·신규 노출 승인을 중지한다. */
  GLOBAL_ADS = 'GLOBAL_ADS',
  /** 적립·확정 배치만 중지한다. 회수와 광고주 환급은 계속 허용한다. */
  GLOBAL_REWARDS = 'GLOBAL_REWARDS',
}

/** 전역 스위치는 임의 문자열 대신 이 고정 식별자를 사용한다. */
export const GLOBAL_KILL_SWITCH_ID = 'GLOBAL';

/**
 * 킬스위치 (CLAW-6, rules §7 서버 킬스위치 유지).
 * 대상(머신/회원/캠페인)을 즉시 수집 거부 목록에 올린다. 운영자가 켜고 끈다.
 * active=false 행도 남겨 이력으로 둔다.
 */
@Entity('kill_switches')
@Index('IDX_kill_switches_lookup', ['target', 'targetId', 'active'])
@Index('UQ_kill_switches_active_target', ['target', 'targetId'], { unique: true, where: '"active" = true' })
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

  @Column({ type: 'varchar', length: 200, nullable: true })
  disabledReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  disabledAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
