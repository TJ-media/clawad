import { MigrationInterface, QueryRunner } from 'typeorm';

/** CLAW-49: 서명 클릭 URL의 단일 사용 기록. */
export class ClickEvents1783812000000 implements MigrationInterface {
  name = 'ClickEvents1783812000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "click_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "clickJti" uuid NOT NULL,
        "campaignId" uuid NOT NULL,
        "creativeId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "machineId" character varying(64) NOT NULL,
        "sequence" integer,
        "clientVersion" character varying(32),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_click_events" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_click_events_click_jti" UNIQUE ("clickJti")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_click_events_campaign_created" ON "click_events" ("campaignId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_click_events_creative_created" ON "click_events" ("creativeId", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "click_events"`);
  }
}
