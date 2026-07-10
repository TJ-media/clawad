import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity';

export enum IdentityProvider {
  EMAIL = 'EMAIL',
  GOOGLE = 'GOOGLE',
  GITHUB = 'GITHUB',
}

/**
 * 로그인 수단. 한 User에 여러 Identity를 연결할 수 있다.
 * passwordHash는 provider=EMAIL일 때만 채운다. 비밀번호 원문·이메일은 로그에 남기지 않는다.
 */
@Entity('identities')
@Index(['provider', 'providerSubject'], { unique: true })
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
