import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-27: admin_users(역할 RBAC), audit_logs(불변 감사로그).
 * audit_logs는 append-only — DB 트리거로 UPDATE·DELETE 차단.
 * 접속 IP·비밀값 컬럼 없음.
 */
export class AdminSecurity1783740000000 implements MigrationInterface {
  name = 'AdminSecurity1783740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "admin_users_role_enum" AS ENUM('SUPERADMIN', 'REVIEWER', 'SETTLER')`);
    await queryRunner.query(`CREATE TYPE "admin_users_status_enum" AS ENUM('ACTIVE', 'DISABLED')`);

    await queryRunner.query(`
      CREATE TABLE "admin_users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying(320) NOT NULL,
        "passwordHash" character varying(255) NOT NULL,
        "role" "admin_users_role_enum" NOT NULL,
        "status" "admin_users_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_admin_users_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id" BIGSERIAL NOT NULL,
        "actorAdminId" uuid,
        "actorRole" character varying(32),
        "action" character varying(200) NOT NULL,
        "targetId" character varying(128),
        "params" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_actor" ON "audit_logs" ("actorAdminId")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_action" ON "audit_logs" ("action")`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs는 불변입니다. 수정·삭제할 수 없습니다.';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_logs_append_only"
      BEFORE UPDATE OR DELETE ON "audit_logs"
      FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_audit_logs_append_only" ON "audit_logs"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_logs_append_only()`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP TABLE "admin_users"`);
    await queryRunner.query(`DROP TYPE "admin_users_status_enum"`);
    await queryRunner.query(`DROP TYPE "admin_users_role_enum"`);
  }
}
