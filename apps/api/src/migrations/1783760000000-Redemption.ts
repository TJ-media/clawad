import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-26: products(교환 카탈로그), redemptions(교환 요청), redemption_ledger(지급 원장, append-only).
 * 세율·과세 컬럼 없음(taxStatus 상태 필드만, CLAW-13 미확정). 쿠폰 수신 연락처 컬럼 없음.
 */
export class Redemption1783760000000 implements MigrationInterface {
  name = 'Redemption1783760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "redemptions_status_enum" AS ENUM('REQUESTED','SUPPLIER_ORDERED','DELIVERED','DELIVERY_FAILED','CANCELED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "redemptions_taxstatus_enum" AS ENUM('NONE','WITHHOLDING_PENDING','WITHHOLDING_DONE','REPORTED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "redemption_ledger_entrytype_enum" AS ENUM('REQUEST','SUPPLIER_ORDER','DELIVERED','DELIVERY_FAILED','CANCELED','RESENT')`,
    );

    await queryRunner.query(`
      CREATE TABLE "products" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(200) NOT NULL,
        "brand" character varying(60) NOT NULL,
        "pointCost" bigint NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_products" PRIMARY KEY ("id"),
        CONSTRAINT "CK_products_point_cost_positive" CHECK ("pointCost" > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "redemptions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "productId" uuid NOT NULL,
        "pointsDebited" bigint NOT NULL,
        "status" "redemptions_status_enum" NOT NULL DEFAULT 'REQUESTED',
        "taxStatus" "redemptions_taxstatus_enum" NOT NULL DEFAULT 'NONE',
        "supplierRef" character varying(200),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_redemptions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_redemptions_product" FOREIGN KEY ("productId") REFERENCES "products"("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_redemptions_user" ON "redemptions" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_redemptions_status" ON "redemptions" ("status")`);

    await queryRunner.query(`
      CREATE TABLE "redemption_ledger" (
        "id" BIGSERIAL NOT NULL,
        "redemptionId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "entryType" "redemption_ledger_entrytype_enum" NOT NULL,
        "detail" character varying(200),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_redemption_ledger" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_redemption_ledger_redemption" ON "redemption_ledger" ("redemptionId")`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION redemption_ledger_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'redemption_ledger는 append-only입니다. 상태 전이는 새 행으로 append하세요.';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_redemption_ledger_append_only"
      BEFORE UPDATE OR DELETE ON "redemption_ledger"
      FOR EACH ROW EXECUTE FUNCTION redemption_ledger_append_only();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_redemption_ledger_append_only" ON "redemption_ledger"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS redemption_ledger_append_only()`);
    await queryRunner.query(`DROP TABLE "redemption_ledger"`);
    await queryRunner.query(`DROP TABLE "redemptions"`);
    await queryRunner.query(`DROP TABLE "products"`);
    await queryRunner.query(`DROP TYPE "redemption_ledger_entrytype_enum"`);
    await queryRunner.query(`DROP TYPE "redemptions_taxstatus_enum"`);
    await queryRunner.query(`DROP TYPE "redemptions_status_enum"`);
  }
}
