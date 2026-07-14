import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 광고 클릭 사실. 클릭 jti의 UNIQUE 제약으로 같은 클릭 URL의 재사용을 거절한다.
 * 광고주 과금·리워드는 이 이벤트에서 결정하지 않으며, 후속 집계 전용이다.
 */
@Entity('click_events')
@Index(['campaignId', 'createdAt'])
@Index(['creativeId', 'createdAt'])
export class ClickEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  clickJti: string;

  @Column({ type: 'uuid' })
  campaignId: string;

  @Column({ type: 'uuid' })
  creativeId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 64 })
  machineId: string;

  /** status line URL은 클릭 시점의 노출 sequence를 알 수 없어 null로 둔다. */
  @Column({ type: 'int', nullable: true })
  sequence: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  clientVersion: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
