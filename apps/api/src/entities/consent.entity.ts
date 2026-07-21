import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity';

/**
 * 동의 항목. 가입 동의를 하나로 묶지 않고 항목별로 독립 저장한다 (privacy-design.md §3).
 * 버전과 시각을 함께 기록해 정책 변경이 과거 동의를 소급 변경하지 않게 한다.
 */
export enum ConsentType {
  /** 필수 */
  TERMS_OF_SERVICE = 'TERMS_OF_SERVICE',
  /** 필수 */
  PRIVACY_POLICY = 'PRIVACY_POLICY',
  /** 선택 */
  MARKETING = 'MARKETING',
  /** 선택 */
  EXTRA_TELEMETRY = 'EXTRA_TELEMETRY',
  /** 별도 선택. 클릭 기능(CLAW-7) 도입 전까지 수집하지 않는다. */
  CLICK_TRACKING = 'CLICK_TRACKING',
}

export const REQUIRED_CONSENTS: readonly ConsentType[] = [ConsentType.TERMS_OF_SERVICE, ConsentType.PRIVACY_POLICY];

@Entity('consents')
@Index(['userId', 'type'])
export class Consent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, (user) => user.consents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'enum', enum: ConsentType })
  type: ConsentType;

  @Column({ type: 'boolean' })
  granted: boolean;

  /** 동의받은 약관·방침의 버전. */
  @Column({ type: 'varchar', length: 32 })
  documentVersion: string;

  @CreateDateColumn({ type: 'timestamptz' })
  recordedAt: Date;
}
