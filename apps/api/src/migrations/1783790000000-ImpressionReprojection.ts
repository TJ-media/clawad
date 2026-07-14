import { MigrationInterface, QueryRunner } from 'typeorm';

/** CLAW-42: append-only 동시 노출 판정 전이와 리워드 비제재 정정 분개. */
export class ImpressionReprojection1783790000000 implements MigrationInterface {
  name = 'ImpressionReprojection1783790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reward_ledger" DROP CONSTRAINT "CK_reward_ledger_sign"`);
    await queryRunner.query(`ALTER TYPE "reward_ledger_entrytype_enum" RENAME TO "reward_ledger_entrytype_enum_old"`);
    await queryRunner.query(`
      CREATE TYPE "reward_ledger_entrytype_enum" AS ENUM (
        'ACCRUE_PENDING','ACCRUE_CONFIRM','CLAW_BACK','REDEEM_DEBIT','ADMIN_ADJUST','REPROJECTION_ADJUST'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "reward_ledger" ALTER COLUMN "entryType" TYPE "reward_ledger_entrytype_enum"
      USING "entryType"::text::"reward_ledger_entrytype_enum"
    `);
    await queryRunner.query(`DROP TYPE "reward_ledger_entrytype_enum_old"`);
    await queryRunner.query(`
      ALTER TABLE "reward_ledger" ADD CONSTRAINT "CK_reward_ledger_sign" CHECK (
        ("entryType" IN ('ACCRUE_PENDING','ACCRUE_CONFIRM') AND "points" >= 0) OR
        ("entryType" IN ('CLAW_BACK','REDEEM_DEBIT') AND "points" <= 0) OR
        ("entryType" IN ('ADMIN_ADJUST','REPROJECTION_ADJUST'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "impression_decision_transitions" (
        "id" BIGSERIAL NOT NULL,
        "impressionEventId" bigint NOT NULL,
        "fromDecision" "impression_events_decision_enum" NOT NULL,
        "toDecision" "impression_events_decision_enum" NOT NULL,
        "reason" character varying(64) NOT NULL,
        "billed" boolean NOT NULL DEFAULT false,
        "rewardEligible" boolean NOT NULL DEFAULT false,
        "companyFunded" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_impression_decision_transitions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_impression_decision_transition_event" FOREIGN KEY ("impressionEventId")
          REFERENCES "impression_events"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_impression_decision_transition_event" ON "impression_decision_transitions" ("impressionEventId", "id")`,
    );
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION impression_decision_transitions_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'impression_decision_transitions는 append-only입니다.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_impression_decision_transitions_append_only"
      BEFORE UPDATE OR DELETE ON "impression_decision_transitions"
      FOR EACH ROW EXECUTE FUNCTION impression_decision_transitions_append_only()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_impression_decision_transitions_append_only" ON "impression_decision_transitions"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS impression_decision_transitions_append_only()`);
    await queryRunner.query(`DROP TABLE "impression_decision_transitions"`);
    await queryRunner.query(`ALTER TABLE "reward_ledger" DROP CONSTRAINT "CK_reward_ledger_sign"`);
    await queryRunner.query(`ALTER TYPE "reward_ledger_entrytype_enum" RENAME TO "reward_ledger_entrytype_enum_new"`);
    await queryRunner.query(`
      CREATE TYPE "reward_ledger_entrytype_enum" AS ENUM (
        'ACCRUE_PENDING','ACCRUE_CONFIRM','CLAW_BACK','REDEEM_DEBIT','ADMIN_ADJUST'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "reward_ledger" ALTER COLUMN "entryType" TYPE "reward_ledger_entrytype_enum"
      USING "entryType"::text::"reward_ledger_entrytype_enum"
    `);
    await queryRunner.query(`DROP TYPE "reward_ledger_entrytype_enum_new"`);
    await queryRunner.query(`
      ALTER TABLE "reward_ledger" ADD CONSTRAINT "CK_reward_ledger_sign" CHECK (
        ("entryType" IN ('ACCRUE_PENDING','ACCRUE_CONFIRM') AND "points" >= 0) OR
        ("entryType" IN ('CLAW_BACK','REDEEM_DEBIT') AND "points" <= 0) OR
        ("entryType" = 'ADMIN_ADJUST')
      )
    `);
  }
}
