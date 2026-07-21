import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ImpressionDecision } from './impression-event.entity';

/**
 * 지연·오프라인 업로드로 동시 노출 승자가 바뀔 때 남기는 append-only 판정 전이(CLAW-42).
 * 원본 impression_events 행은 수정하지 않고, 가장 최근 전이가 현재 유효 판정과 자격을 나타낸다.
 */
@Entity('impression_decision_transitions')
@Index(['impressionEventId', 'id'])
export class ImpressionDecisionTransition {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  impressionEventId: string;

  @Column({ type: 'enum', enum: ImpressionDecision, enumName: 'impression_events_decision_enum' })
  fromDecision: ImpressionDecision;

  @Column({ type: 'enum', enum: ImpressionDecision, enumName: 'impression_events_decision_enum' })
  toDecision: ImpressionDecision;

  @Column({ type: 'varchar', length: 64 })
  reason: string;

  @Column({ type: 'boolean', default: false })
  billed: boolean;

  @Column({ type: 'boolean', default: false })
  rewardEligible: boolean;

  @Column({ type: 'boolean', default: false })
  companyFunded: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
