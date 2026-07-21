import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity';

export enum IdentityProvider {
  /** legacy. 공개 로그인은 비활성(CLAW-37). 기존 행은 승인된 migration 전까지 보존한다. */
  EMAIL = 'EMAIL',
  GOOGLE = 'GOOGLE',
  /** legacy. 공개 로그인은 비활성(CLAW-37). */
  GITHUB = 'GITHUB',
  KAKAO = 'KAKAO',
  NAVER = 'NAVER',
}

/** 신규 공개 소셜 로그인·가입·연결이 허용되는 공급자 (CLAW-37). EMAIL·GITHUB은 legacy로 제외. */
export const ACTIVE_SOCIAL_PROVIDERS: readonly IdentityProvider[] = [
  IdentityProvider.GOOGLE,
  IdentityProvider.KAKAO,
  IdentityProvider.NAVER,
];

/**
 * 로그인 수단. 한 User에 여러 Identity를 연결할 수 있다.
 * passwordHash는 provider=EMAIL일 때만 채운다(legacy). 비밀번호 원문·이메일은 로그에 남기지 않는다.
 *
 * 유일성: (provider, providerSubject)는 전역 유일 — 하나의 소셜 계정이 두 사용자에 붙지 않는다.
 * (userId, provider)도 유일 — 한 사용자는 provider당 하나의 identity만 연결한다 (CLAW-37).
 */
@Entity('identities')
@Index(['provider', 'providerSubject'], { unique: true })
@Index(['userId', 'provider'], { unique: true })
export class Identity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, (user) => user.identities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'enum', enum: IdentityProvider })
  provider: IdentityProvider;

  /** EMAIL이면 정규화된 이메일, 소셜이면 공급자의 subject(sub) 값. */
  @Column({ type: 'varchar', length: 320 })
  providerSubject: string;

  /** scrypt 해시. provider=EMAIL 전용. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  passwordHash: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
