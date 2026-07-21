import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Campaign } from './campaign.entity';

export enum CreativeStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  /** 새 버전이 나와 더 이상 노출하지 않는 버전. */
  SUPERSEDED = 'SUPERSEDED',
}

/**
 * 크리에이티브(광고 소재). 버전 단위로 append하며 기존 행의 text를 수정하지 않는다.
 * 소재를 바꾸면 새 버전을 만들고 PENDING_REVIEW로 재심사한다 (CLAW-20 §"소재 변경 시 재심사").
 *
 * `[광고]` 표기는 시스템이 노출 시점에 자동 부착한다. text에 포함하지 않는다.
 */
@Entity('creatives')
@Index(['campaignId', 'version'], { unique: true })
@Index(['campaignId', 'status'])
export class Creative {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  campaignId: string;

  @ManyToOne(() => Campaign, (c) => c.creatives, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaignId' })
  campaign: Campaign;

  @Column({ type: 'int' })
  version: number;

  /** 한 줄, 제어문자 제거됨 (CLAW-20 §공통 심사). */
  @Column({ type: 'varchar', length: 120 })
  text: string;

  @Column({ type: 'varchar', length: 60 })
  brand: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  landingUrl: string | null;

  @Column({ type: 'enum', enum: CreativeStatus, default: CreativeStatus.PENDING_REVIEW })
  status: CreativeStatus;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reviewNote: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
