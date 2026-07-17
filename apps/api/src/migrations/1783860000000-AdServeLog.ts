import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-71 광고 결정(serveToken 발급) 집계 로그:
 *  - 노출 퍼널의 첫 단계 "광고 결정" 수를 시간범위로 세기 위한 append-only 저카디널리티 로그.
 *  - serveToken 발급은 registry(jti·해시)로만 관리돼 시간범위 집계에 부적합하므로 별도로 둔다.
 *  - **사용자를 식별하지 않는다**: userId·machineId·serveToken을 저장하지 않는다. 캠페인/소재 차원과
 *    발급 시각만 남긴다. 개인정보 이벤트 원장(impression_events)과 조인하지 않는다.
 */
export class AdServeLog1783860000000 implements MigrationInterface {
  name = 'AdServeLog1783860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ad_serve_log" (
        "id" BIGSERIAL NOT NULL,
        "campaignId" uuid NOT NULL,
        "campaignType" character varying(16) NOT NULL,
        "creativeId" uuid,
        "servedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ad_serve_log" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_ad_serve_log_served_at" ON "ad_serve_log" ("servedAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_ad_serve_log_campaign" ON "ad_serve_log" ("campaignId", "servedAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ad_serve_log"`);
  }
}
