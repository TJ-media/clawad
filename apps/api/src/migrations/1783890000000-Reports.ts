import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-234 이용자 제보.
 *
 * 포상 적립은 기존 `PROMO_ACCRUE`(CLAW-97에서 추가)를 그대로 쓴다 — enum도 CHECK 제약도
 * 건드리지 않는다. 제보 1건당 하나의 포상은 기존
 * `UQ_reward_ledger_ref_type(refIdempotencyKey, entryType)`에 `report:{id}` 키를 태워 얻는다.
 *
 * `replyEmail`은 제보 한 건의 스냅샷이며 답변 완료 시 NULL로 파기한다. `users.email`은 계속 NULL이다
 * (privacy-design.md §1.5.3, 처리방침 v4 제1장 다-2.).
 */
export class Reports1783890000000 implements MigrationInterface {
  name = 'Reports1783890000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "reports_status_enum" AS ENUM ('OPEN','ANSWERED')`);
    await queryRunner.query(`
      CREATE TABLE "reports" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "body" text NOT NULL,
        "status" "reports_status_enum" NOT NULL DEFAULT 'OPEN',
        "replyEmail" character varying(254),
        "replyEmailConsentAt" TIMESTAMP WITH TIME ZONE,
        "reply" text,
        "repliedAt" TIMESTAMP WITH TIME ZONE,
        "rewardPoints" integer NOT NULL DEFAULT 0,
        "readAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reports" PRIMARY KEY ("id"),
        CONSTRAINT "FK_reports_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "CK_reports_reward_points" CHECK ("rewardPoints" >= 0)
      )
    `);
    // 내 제보 목록(최신순)과 운영자 미답변 목록이 각각 쓰는 인덱스다.
    await queryRunner.query(`CREATE INDEX "IX_reports_user_created" ON "reports" ("userId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX "IX_reports_status_created" ON "reports" ("status", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "reports"`);
    await queryRunner.query(`DROP TYPE "reports_status_enum"`);
  }
}
