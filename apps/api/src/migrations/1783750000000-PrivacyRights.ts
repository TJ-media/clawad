import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-28: users에 WITHDRAWN 상태·withdrawnAt 추가, destruction_logs(파기 로그, append-only).
 */
export class PrivacyRights1783750000000 implements MigrationInterface {
  name = 'PrivacyRights1783750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "users_status_enum" ADD VALUE IF NOT EXISTS 'WITHDRAWN'`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "withdrawnAt" TIMESTAMP WITH TIME ZONE`);

    await queryRunner.query(
      `CREATE TYPE "destruction_logs_action_enum" AS ENUM('WITHDRAWAL', 'RETENTION_SWEEP')`,
    );
    await queryRunner.query(`
      CREATE TABLE "destruction_logs" (
        "id" BIGSERIAL NOT NULL,
        "userId" uuid,
        "action" "destruction_logs_action_enum" NOT NULL,
        "detail" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_destruction_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_destruction_logs_user" ON "destruction_logs" ("userId")`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION destruction_logs_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'destruction_logs는 불변입니다. 수정·삭제할 수 없습니다.';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_destruction_logs_append_only"
      BEFORE UPDATE OR DELETE ON "destruction_logs"
      FOR EACH ROW EXECUTE FUNCTION destruction_logs_append_only();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_destruction_logs_append_only" ON "destruction_logs"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS destruction_logs_append_only()`);
    await queryRunner.query(`DROP TABLE "destruction_logs"`);
    await queryRunner.query(`DROP TYPE "destruction_logs_action_enum"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "withdrawnAt"`);
    // enum 값 제거는 PostgreSQL이 지원하지 않으므로 WITHDRAWN은 남긴다(무해).
  }
}
