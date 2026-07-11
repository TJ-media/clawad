import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Identity } from './identity.entity';
import { Machine } from './machine.entity';
import { Consent } from './consent.entity';

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  /** 탈퇴. 직접 식별자(이메일·로그인 수단)는 파기되고 원장은 가명 id로 잔존한다 (CLAW-28). */
  WITHDRAWN = 'WITHDRAWN',
}

/**
 * 사용자 계정. 여러 로그인 수단(이메일·Google·GitHub)은 Identity로 이 계정에 연결된다.
 * 로그인 수단이 여러 개인 것을 다계정으로 보지 않는다 (CLAW-16 §A.6).
 *
 * 개인정보: 이 테이블에 접속 IP·하드웨어 식별자를 저장하지 않는다 (privacy-design.md §2, §6.6).
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 320, unique: true, nullable: true })
  email: string | null;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @Column({ type: 'timestamptz', nullable: true })
  withdrawnAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => Identity, (identity) => identity.user)
  identities: Identity[];

  @OneToMany(() => Machine, (machine) => machine.user)
  machines: Machine[];

  @OneToMany(() => Consent, (consent) => consent.user)
  consents: Consent[];
}
