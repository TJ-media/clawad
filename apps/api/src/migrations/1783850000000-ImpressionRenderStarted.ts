import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-71 표시 시작 신호:
 *  - impression_events에 renderStarted(광고가 화면에 처음 렌더된 시각, epoch ms)를 추가한다.
 *  - startedAt/endedAt(Claude 작업 활성 유효 구간)과 별개 신호다 — 결정→표시→유효 퍼널의
 *    "표시 시작" 단계를 관측하기 위한 진단 전용 값이며 노출 인정/과금/리워드 판정에 쓰지 않는다.
 *  - 레거시·미전송 클라이언트는 NULL이다. 하드웨어 식별자·IP·프롬프트 등은 여전히 수집하지 않는다.
 *    (privacy-design.md §1.1의 전송 허용목록을 함께 갱신했다.)
 */
export class ImpressionRenderStarted1783850000000 implements MigrationInterface {
  name = 'ImpressionRenderStarted1783850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "renderStarted" bigint`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "impression_events" DROP COLUMN "renderStarted"`);
  }
}
