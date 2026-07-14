import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('decision_policy_snapshots')
export class DecisionPolicySnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  contentHash: string;

  @Column({ type: 'int' })
  policyVersion: number;

  @Column({ type: 'jsonb' })
  snapshot: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
