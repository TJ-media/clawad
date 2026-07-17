import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 광고 결정(serveToken 발급) 집계 로그 (CLAW-71). append-only.
 *
 * 노출 퍼널의 첫 단계 "광고 결정" 수를 시간범위로 세기 위한 저카디널리티 로그다.
 * **사용자를 식별하지 않는다** — userId·machineId·serveToken을 담지 않는다(privacy-design.md §1.6).
 * 개인정보 이벤트 원장(impression_events)과 조인하지 않는다.
 */
@Entity('ad_serve_log')
@Index(['servedAt'])
@Index(['campaignId', 'servedAt'])
export class AdServeLog {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  campaignId: string;

  @Column({ type: 'varchar', length: 16 })
  campaignType: string;

  @Column({ type: 'uuid', nullable: true })
  creativeId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  servedAt: Date;
}
