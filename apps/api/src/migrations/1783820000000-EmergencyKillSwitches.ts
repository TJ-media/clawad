import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-65: 전역 광고·적립 긴급 중지와 active 스위치 멱등성.
 *
 * kill_switches는 정산 원장이 아니므로 상태 해제 시 active를 전이한다. 다만 같은 대상의
 * active 행은 DB partial unique index로 하나만 허용해 다중 API 인스턴스의 동시 enable도
 * 한 상태로 수렴시킨다.
 */
export class EmergencyKillSwitches1783820000000 implements MigrationInterface {
  name = 'EmergencyKillSwitches1783820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "kill_switches_target_enum" ADD VALUE IF NOT EXISTS 'GLOBAL_ADS'`);
    await queryRunner.query(`ALTER TYPE "kill_switches_target_enum" ADD VALUE IF NOT EXISTS 'GLOBAL_REWARDS'`);
    await queryRunner.query(`ALTER TABLE kill_switches ADD COLUMN "disabledReason" character varying(200)`);
    await queryRunner.query(`ALTER TABLE kill_switches ADD COLUMN "disabledAt" TIMESTAMP WITH TIME ZONE`);

    // 구 API가 대문자 UUID 원문을 varchar에 저장한 경우 PostgreSQL uuid 문자열과의
    // case-sensitive 비교가 어긋난다. 유효한 USER/CAMPAIGN UUID는 index dedupe 전에 정규화한다.
    await queryRunner.query(`
      UPDATE kill_switches
      SET "targetId" = lower("targetId")
      WHERE target::text IN ('USER', 'CAMPAIGN')
        AND "targetId" ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
    `);

    // 구 버전에서 동시 enable로 중복 active 행이 생겼다면 가장 오래된 한 행만 유지한다.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY target, "targetId" ORDER BY "createdAt", id
        ) AS ordinal
        FROM kill_switches
        WHERE active = true
      )
      UPDATE kill_switches k
      SET active = false,
          "disabledReason" = 'MIGRATION_ACTIVE_DEDUPLICATE',
          "disabledAt" = transaction_timestamp()
      FROM ranked r
      WHERE k.id = r.id AND r.ordinal > 1
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_kill_switches_active_target"
      ON kill_switches (target, "targetId") WHERE active = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_kill_switches_active_target"`);
    await queryRunner.query(`ALTER TABLE kill_switches DROP COLUMN "disabledAt", DROP COLUMN "disabledReason"`);
    await queryRunner.query(`DELETE FROM kill_switches WHERE target::text IN ('GLOBAL_ADS', 'GLOBAL_REWARDS')`);
    await queryRunner.query(`ALTER TYPE "kill_switches_target_enum" RENAME TO "kill_switches_target_enum_with_global"`);
    await queryRunner.query(`CREATE TYPE "kill_switches_target_enum" AS ENUM('MACHINE', 'USER', 'CAMPAIGN')`);
    await queryRunner.query(`
      ALTER TABLE kill_switches ALTER COLUMN target TYPE "kill_switches_target_enum"
      USING target::text::"kill_switches_target_enum"
    `);
    await queryRunner.query(`DROP TYPE "kill_switches_target_enum_with_global"`);
  }
}
