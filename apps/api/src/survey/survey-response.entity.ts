import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 만족도 설문 응답 (CLAW-97). 사용자당 설문 버전당 1건.
 *
 * 응답은 리워드 지급을 위해 계정과 연결해 저장한다. 광고 노출 이벤트 원장(impression_events)과
 * 조인하지 않으며, 접속 IP·하드웨어 식별자 컬럼을 두지 않는다 (privacy-design.md §2).
 * 수집 항목·목적·보유기간은 privacy-design.md §1.5.2·§4에 정의돼 있다.
 * 공개 처리방침 갱신·게시는 CLAW-98이며, **그 전에는 이 기능을 운영에 배포하지 않는다.**
 */
@Entity('survey_responses')
@Index(['userId', 'surveyVersion'], { unique: true })
export class SurveyResponse {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 32 })
  surveyVersion: string;

  /** 문항 키 → 선택지 코드 또는 자유 텍스트. 서버 정의로 검증된 값만 저장된다. */
  @Column({ type: 'jsonb' })
  answers: Record<string, string>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
