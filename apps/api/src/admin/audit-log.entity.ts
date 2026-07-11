import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 감사로그 (CLAW-27). 모든 운영자 조작을 불변으로 기록한다.
 * append-only — DB 트리거로 UPDATE·DELETE 차단. 조작 실행 전에 기록하며, 기록 실패 시 조작을 차단한다.
 *
 * params에는 비밀값·PII를 남기지 않는다(비밀번호·토큰·이메일은 마스킹). 접속 IP를 저장하지 않는다.
 */
@Entity('audit_logs')
@Index(['actorAdminId'])
@Index(['action'])
export class AuditLog {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  /** 조작한 관리자. 부트스트랩 등 시스템 조작은 null. */
  @Column({ type: 'uuid', nullable: true })
  actorAdminId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  actorRole: string | null;

  /** 예: "POST /internal/v1/campaigns/:id/transition". */
  @Column({ type: 'varchar', length: 200 })
  action: string;

  /** 대상 식별자(경로 파라미터). 없으면 null. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  targetId: string | null;

  /** 마스킹된 요청 본문(JSON 문자열). 비밀값·PII 제거됨. */
  @Column({ type: 'text', nullable: true })
  params: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
