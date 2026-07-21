import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-23: advertisers, campaigns, creatives, billing_ledger.
 *
 * billing_ledger는 append-only다. UPDATE·DELETE를 하지 않으며 정정은 반대 분개로 append한다.
 * entry_type에 RESERVE/RELEASE를 정의만 해두고 알파에서는 쓰지 않는다 (ledgers.md §예산 처리 방식).
 * 잔액 컬럼을 두지 않는다 — 가용 예산은 항상 SUM(amount_krw)로 계산한다.
 */
export class CampaignBudget1783710000000 implements MigrationInterface {
  name = 'CampaignBudget1783710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "advertisers_status_enum" AS ENUM('ACTIVE', 'SUSPENDED')`);
    await queryRunner.query(`CREATE TYPE "campaigns_type_enum" AS ENUM('PAID', 'HOUSE', 'TEST')`);
    await queryRunner.query(
      `CREATE TYPE "campaigns_status_enum" AS ENUM('DRAFT', 'PENDING_REVIEW', 'REJECTED', 'APPROVED', 'ACTIVE', 'PAUSED', 'ENDED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "creatives_status_enum" AS ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "billing_ledger_entrytype_enum" AS ENUM('DEPOSIT', 'BONUS_CREDIT', 'CAPTURE', 'REFUND', 'IVT_REFUND', 'RESERVE', 'RELEASE')`,
    );

    await queryRunner.query(`
      CREATE TABLE "advertisers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(200) NOT NULL,
        "status" "advertisers_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "dailyImpressionLimit" integer,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_advertisers" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "campaigns" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "advertiserId" uuid NOT NULL,
        "name" character varying(200) NOT NULL,
        "type" "campaigns_type_enum" NOT NULL,
        "status" "campaigns_status_enum" NOT NULL DEFAULT 'DRAFT',
        "pricePerImpressionKrw" bigint NOT NULL,
        "rewardPolicyId" character varying(64),
        "startsAt" TIMESTAMP WITH TIME ZONE,
        "endsAt" TIMESTAMP WITH TIME ZONE,
        "reviewNote" character varying(200),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_campaigns" PRIMARY KEY ("id"),
        CONSTRAINT "FK_campaigns_advertiser" FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE CASCADE,
        -- HOUSE·TEST는 광고주 과금을 만들지 않으므로 단가가 0이어야 한다.
        CONSTRAINT "CK_campaigns_non_paid_zero_price" CHECK ("type" = 'PAID' OR "pricePerImpressionKrw" = 0),
        -- TEST는 어떤 경우에도 리워드를 만들지 않는다.
        CONSTRAINT "CK_campaigns_test_no_reward_policy" CHECK ("type" <> 'TEST' OR "rewardPolicyId" IS NULL)
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_campaigns_status" ON "campaigns" ("status")`);

    await queryRunner.query(`
      CREATE TABLE "creatives" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "campaignId" uuid NOT NULL,
        "version" integer NOT NULL,
        "text" character varying(120) NOT NULL,
        "brand" character varying(60) NOT NULL,
        "landingUrl" character varying(2048),
        "status" "creatives_status_enum" NOT NULL DEFAULT 'PENDING_REVIEW',
        "reviewNote" character varying(200),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_creatives" PRIMARY KEY ("id"),
        CONSTRAINT "FK_creatives_campaign" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_creatives_campaign_version" ON "creatives" ("campaignId", "version")`);
    await queryRunner.query(`CREATE INDEX "IDX_creatives_campaign_status" ON "creatives" ("campaignId", "status")`);
    // 캠페인당 승인된 소재는 최대 1개. 두 버전이 동시에 노출되지 않게 한다.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_creatives_one_approved_per_campaign" ON "creatives" ("campaignId") WHERE "status" = 'APPROVED'`,
    );

    await queryRunner.query(`
      CREATE TABLE "billing_ledger" (
        "id" BIGSERIAL NOT NULL,
        "advertiserId" uuid NOT NULL,
        "campaignId" uuid NOT NULL,
        "entryType" "billing_ledger_entrytype_enum" NOT NULL,
        "amountKrw" bigint NOT NULL,
        "idempotencyKey" character varying(128),
        "reason" character varying(64),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_billing_ledger" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_ledger_campaign" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE,
        -- 같은 노출로 두 번 과금하지 않는다 (CLAW-18 멱등 키).
        CONSTRAINT "UQ_billing_ledger_idempotency_key" UNIQUE ("idempotencyKey"),
        -- CAPTURE는 음수, 그 외 알파 유형은 양수여야 한다.
        CONSTRAINT "CK_billing_ledger_capture_sign" CHECK (
          ("entryType" = 'CAPTURE' AND "amountKrw" < 0) OR
          ("entryType" <> 'CAPTURE' AND "amountKrw" > 0)
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_billing_ledger_campaign" ON "billing_ledger" ("campaignId")`);

    // append-only 강제: 원장 행의 UPDATE·DELETE를 DB 레벨에서 막는다 (CLAW-17).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION billing_ledger_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'billing_ledger는 append-only입니다. 정정은 반대 분개를 append하세요.';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_billing_ledger_append_only"
      BEFORE UPDATE OR DELETE ON "billing_ledger"
      FOR EACH ROW EXECUTE FUNCTION billing_ledger_append_only();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_billing_ledger_append_only" ON "billing_ledger"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS billing_ledger_append_only()`);
    await queryRunner.query(`DROP TABLE "billing_ledger"`);
    await queryRunner.query(`DROP TABLE "creatives"`);
    await queryRunner.query(`DROP TABLE "campaigns"`);
    await queryRunner.query(`DROP TABLE "advertisers"`);
    await queryRunner.query(`DROP TYPE "billing_ledger_entrytype_enum"`);
    await queryRunner.query(`DROP TYPE "creatives_status_enum"`);
    await queryRunner.query(`DROP TYPE "campaigns_status_enum"`);
    await queryRunner.query(`DROP TYPE "campaigns_type_enum"`);
    await queryRunner.query(`DROP TYPE "advertisers_status_enum"`);
  }
}
