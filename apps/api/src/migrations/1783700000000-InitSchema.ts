import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-22 초기 스키마: users, identities, machines, consents.
 *
 * 이 스키마에는 접속 IP 컬럼이 없다. IP는 제품 이벤트 데이터가 아니다 (privacy-design.md §6.6).
 * 하드웨어 식별자 컬럼도 두지 않는다. machineId는 클라이언트가 만든 가명값이다.
 */
export class InitSchema1783700000000 implements MigrationInterface {
  name = 'InitSchema1783700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`CREATE TYPE "users_status_enum" AS ENUM('ACTIVE', 'SUSPENDED')`);
    await queryRunner.query(`CREATE TYPE "identities_provider_enum" AS ENUM('EMAIL', 'GOOGLE', 'GITHUB')`);
    await queryRunner.query(`CREATE TYPE "machines_status_enum" AS ENUM('ACTIVE', 'RELEASED', 'BLOCKED')`);
    await queryRunner.query(
      `CREATE TYPE "consents_type_enum" AS ENUM('TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'MARKETING', 'EXTRA_TELEMETRY', 'CLICK_TRACKING')`,
    );

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying(320),
        "status" "users_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "identities" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "provider" "identities_provider_enum" NOT NULL,
        "providerSubject" character varying(320) NOT NULL,
        "passwordHash" character varying(255),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_identities" PRIMARY KEY ("id"),
        CONSTRAINT "FK_identities_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_identities_provider_subject" ON "identities" ("provider", "providerSubject")`,
    );

    await queryRunner.query(`
      CREATE TABLE "machines" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "machineId" character varying(64) NOT NULL,
        "status" "machines_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "blockedReason" character varying(64),
        "registeredAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "releasedAt" TIMESTAMP WITH TIME ZONE,
        "blockedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_machines" PRIMARY KEY ("id"),
        CONSTRAINT "FK_machines_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    // 계정당 machineId 유일. 서로 다른 계정이 같은 machineId를 갖는 것은 허용하고 위험 신호로만 다룬다 (CLAW-19).
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_machines_user_machine" ON "machines" ("userId", "machineId")`);
    await queryRunner.query(`CREATE INDEX "IDX_machines_machine_id" ON "machines" ("machineId")`);

    await queryRunner.query(`
      CREATE TABLE "consents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "type" "consents_type_enum" NOT NULL,
        "granted" boolean NOT NULL,
        "documentVersion" character varying(32) NOT NULL,
        "recordedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_consents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_consents_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_consents_user_type" ON "consents" ("userId", "type")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "consents"`);
    await queryRunner.query(`DROP TABLE "machines"`);
    await queryRunner.query(`DROP TABLE "identities"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "consents_type_enum"`);
    await queryRunner.query(`DROP TYPE "machines_status_enum"`);
    await queryRunner.query(`DROP TYPE "identities_provider_enum"`);
    await queryRunner.query(`DROP TYPE "users_status_enum"`);
  }
}
