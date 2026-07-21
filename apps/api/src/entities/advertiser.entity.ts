import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Campaign } from './campaign.entity';

export enum AdvertiserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

@Entity('advertisers')
export class Advertiser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: AdvertiserStatus, default: AdvertiserStatus.ACTIVE })
  status: AdvertiserStatus;

  /** 광고주 단위 일일 노출 상한. null이면 무제한. 캠페인 상한과 별개다. */
  @Column({ type: 'int', nullable: true })
  dailyImpressionLimit: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => Campaign, (c) => c.advertiser)
  campaigns: Campaign[];
}
