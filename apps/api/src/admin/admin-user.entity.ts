import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 관리자 역할 (CLAW-27). 사용자 계정(users)과 완전히 분리된 테이블이다.
 * SUPERADMIN은 모든 조작 + 관리자·킬스위치 관리. REVIEWER는 심사·전이. SETTLER는 예산·리워드 정산.
 */
export enum AdminRole {
  SUPERADMIN = 'SUPERADMIN',
  REVIEWER = 'REVIEWER',
  SETTLER = 'SETTLER',
}

export enum AdminStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

@Entity('admin_users')
export class AdminUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 320, unique: true })
  email: string;

  /** scrypt 해시(client/machine과 무관, 서버 common/password). 원문·해시를 로그에 남기지 않는다. */
  @Column({ type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ type: 'enum', enum: AdminRole })
  role: AdminRole;

  @Column({ type: 'enum', enum: AdminStatus, default: AdminStatus.ACTIVE })
  status: AdminStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
