import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-6: impression_events(광고 이벤트 원장), kill_switches.
 *
 * impression_events는 append-only다. DB 트리거로 UPDATE·DELETE를 막는다 (CLAW-17).
 * 접속 IP 컬럼을 두지 않는다 (privacy-design.md §6.6).
 */
export class ImpressionEvents1783720000000 implements MigrationInterface {
  name = 'ImpressionEvents1783720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "impression_events_decision_enum" AS ENUM('ACCEPTED', 'REJECTED')`);
    await queryRunner.query(`CREATE TYPE "kill_switches_target_enum" AS ENUM('MACHINE', 'USER', 'CAMPAIGN')`);

    await queryRunner.query(`
      CREATE TABLE "impression_events" (
        "id" BIGSERIAL NOT NULL,
        "idempotencyKey" character varying(128) NOT NULL,
        "tokenJti" character varying(64) NOT NULL,
        "campaignId" uuid NOT NULL,
        "campaignType" character varying(16) NOT NULL,
        "creativeId" uuid,
        "userId" uuid NOT NULL,
        "machineId" character varying(64) NOT NULL,
        "sequence" integer NOT NULL,
        "startedAt" bigint NOT NULL,
        "endedAt" bigint NOT NULL,
        "decision" "impression_events_decision_enum" NOT NULL,
        "reason" character varying(40),
        "billed" boolean NOT NULL DEFAULT false,
        "rewardEligible" boolean NOT NULL DEFAULT false,
        "companyFunded" boolean NOT NULL DEFAULT false,
        "clientVersion" character varying(32),
        "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_impression_events" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_impression_events_idempotency_key" UNIQUE ("idempotencyKey")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_impression_events_user_decision" ON "impression_events" ("userId", "decision")`);
    await queryRunner.query(`CREATE INDEX "IDX_impression_events_token_jti" ON "impression_events" ("tokenJti")`);
    // 유효 노출 상한(계정 단위)을 일자 경계로 집계할 때 쓴다.
    await queryRunner.query(
      `CREATE INDEX "IDX_impression_events_user_accepted" ON "impression_events" ("userId", "receivedAt") WHERE "decision" = 'ACCEPTED'`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION impression_events_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'impression_events는 append-only입니다. 정정은 판정 전이를 새 행으로 append하세요.';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_impression_events_append_only"
      BEFORE UPDATE OR DELETE ON "impression_events"
      FOR EACH ROW EXECUTE FUNCTION impression_events_append_only();
    `);

    await queryRunner.query(`
      CREATE TABLE "kill_switches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "target" "kill_switches_target_enum" NOT NULL,
        "targetId" character varying(64) NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "reason" character varying(200),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kill_switches" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_kill_switches_lookup" ON "kill_switches" ("target", "targetId", "active")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "kill_switches"`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_impression_events_append_only" ON "impression_events"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS impression_events_append_only()`);
    await queryRunner.query(`DROP TABLE "impression_events"`);
    await queryRunner.query(`DROP TYPE "kill_switches_target_enum"`);
    await queryRunner.query(`DROP TYPE "impression_events_decision_enum"`);
  }
}
