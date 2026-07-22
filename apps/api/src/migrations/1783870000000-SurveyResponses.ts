import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-97 만족도 설문 응답 저장 + 프로모션 적립 유형:
 *  - survey_responses: 사용자당 설문 버전당 1건. UNIQUE(userId, surveyVersion)이 재제출을 막는다.
 *  - reward_ledger_entrytype_enum에 PROMO_ACCRUE 추가. 광고 노출이 아닌 회사 재원 프로모션 적립이며
 *    pending을 거치지 않고 즉시 확정으로 잡는다.
 *  - **CK_reward_ledger_sign에 PROMO_ACCRUE를 함께 넣는다.** 부호 제약을 갱신하지 않으면
 *    양수 포인트의 PROMO_ACCRUE가 세 분기 모두에 걸리지 않아 23514로 거절된다.
 *
 * enum 확장은 CLAW-42(1783790000000)와 같은 재생성 패턴을 쓴다. `ALTER TYPE ... ADD VALUE`로
 * 추가하면 같은 트랜잭션에서 그 값을 CHECK 제약에 쓸 수 없어("unsafe use of new value")
 * 마이그레이션을 두 개로 쪼개야 한다.
 *
 * 설문 리워드의 1인 1회 보장은 기존 UQ_reward_ledger_ref_type(refIdempotencyKey, entryType)에
 * `survey:{version}:{userId}` 키를 태워서 얻는다 — 새 유니크 인덱스를 추가하지 않는다.
 */
export class SurveyResponses1783870000000 implements MigrationInterface {
  name = 'SurveyResponses1783870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reward_ledger" DROP CONSTRAINT "CK_reward_ledger_sign"`);
    await queryRunner.query(`ALTER TYPE "reward_ledger_entrytype_enum" RENAME TO "reward_ledger_entrytype_enum_old"`);
    await queryRunner.query(`
      CREATE TYPE "reward_ledger_entrytype_enum" AS ENUM (
        'ACCRUE_PENDING','ACCRUE_CONFIRM','CLAW_BACK','REDEEM_DEBIT','ADMIN_ADJUST','REPROJECTION_ADJUST','PROMO_ACCRUE'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "reward_ledger" ALTER COLUMN "entryType" TYPE "reward_ledger_entrytype_enum"
      USING "entryType"::text::"reward_ledger_entrytype_enum"
    `);
    await queryRunner.query(`DROP TYPE "reward_ledger_entrytype_enum_old"`);
    await queryRunner.query(`
      ALTER TABLE "reward_ledger" ADD CONSTRAINT "CK_reward_ledger_sign" CHECK (
        ("entryType" IN ('ACCRUE_PENDING','ACCRUE_CONFIRM','PROMO_ACCRUE') AND "points" >= 0) OR
        ("entryType" IN ('CLAW_BACK','REDEEM_DEBIT') AND "points" <= 0) OR
        ("entryType" IN ('ADMIN_ADJUST','REPROJECTION_ADJUST'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "survey_responses" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "surveyVersion" character varying(32) NOT NULL,
        "answers" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_survey_responses" PRIMARY KEY ("id"),
        CONSTRAINT "FK_survey_responses_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_survey_responses_user_version" ON "survey_responses" ("userId", "surveyVersion")`,
    );
  }

  /**
   * PROMO_ACCRUE 행이 이미 있으면 USING 캐스트가 실패한다 — 원장은 append-only라 그 행을 지울 수 없으므로
   * 그 상태에서는 되돌릴 수 없는 것이 맞다. 되돌릴 수 있는 것은 적립이 한 번도 일어나지 않은 경우뿐이다.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "survey_responses"`);
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
  }
}
