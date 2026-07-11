import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-5: reward_ledger(사용자 리워드 원장).
 * append-only — DB 트리거로 UPDATE·DELETE 차단 (CLAW-17).
 * 세율·과세 컬럼 없음(CLAW-13 미확정). IP·하드웨어 식별자 컬럼 없음.
 */
export class RewardLedger1783730000000 implements MigrationInterface {
  name = 'RewardLedger1783730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "reward_ledger_entrytype_enum" AS ENUM('ACCRUE_PENDING', 'ACCRUE_CONFIRM', 'CLAW_BACK', 'REDEEM_DEBIT', 'ADMIN_ADJUST')`,
    );
    await queryRunner.query(`CREATE TYPE "reward_ledger_funding_enum" AS ENUM('ADVERTISER', 'COMPANY')`);

    await queryRunner.query(`
      CREATE TABLE "reward_ledger" (
        "id" BIGSERIAL NOT NULL,
        "userId" uuid NOT NULL,
        "entryType" "reward_ledger_entrytype_enum" NOT NULL,
        "points" bigint NOT NULL,
        "refIdempotencyKey" character varying(128),
        "funding" "reward_ledger_funding_enum",
        "reason" character varying(64),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reward_ledger" PRIMARY KEY ("id"),
        -- pending/confirm/claw_back의 부호 방향을 강제한다.
        CONSTRAINT "CK_reward_ledger_sign" CHECK (
          ("entryType" IN ('ACCRUE_PENDING','ACCRUE_CONFIRM') AND "points" >= 0) OR
          ("entryType" IN ('CLAW_BACK','REDEEM_DEBIT') AND "points" <= 0) OR
          ("entryType" = 'ADMIN_ADJUST')
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_reward_ledger_user_type" ON "reward_ledger" ("userId", "entryType")`);
    // 같은 노출을 유형별로 최대 1행씩만: 중복 적립·중복 확정·중복 회수 방지.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_reward_ledger_ref_type" ON "reward_ledger" ("refIdempotencyKey", "entryType") WHERE "refIdempotencyKey" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION reward_ledger_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'reward_ledger는 append-only입니다. 정정은 반대 분개를 append하세요.';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_reward_ledger_append_only"
      BEFORE UPDATE OR DELETE ON "reward_ledger"
      FOR EACH ROW EXECUTE FUNCTION reward_ledger_append_only();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_reward_ledger_append_only" ON "reward_ledger"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS reward_ledger_append_only()`);
    await queryRunner.query(`DROP TABLE "reward_ledger"`);
    await queryRunner.query(`DROP TYPE "reward_ledger_funding_enum"`);
    await queryRunner.query(`DROP TYPE "reward_ledger_entrytype_enum"`);
  }
}
