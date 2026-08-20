import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-249 광고 신청 접수.
 *
 * 4원장과 분리한 집행 전 접수 테이블이다 (rules §4). 입금을 확인해 캠페인을 만드는 시점에
 * `campaignId`로 이어지고, 그때 비로소 과금 원장이 생긴다.
 *
 * 비로그인 공개 폼이 쓰므로 `userId`가 없다. **접속 IP 컬럼을 두지 않는다** (rules §6) —
 * 레이트리밋은 Redis의 짧은 TTL 키로만 처리하고 이 테이블과 조인하지 않는다.
 */
export class Inquiries1783900000000 implements MigrationInterface {
  name = 'Inquiries1783900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "inquiries_status_enum" AS ENUM ('RECEIVED','DEPOSIT_CONFIRMED','RUNNING','EXHAUSTED','CANCELLED')`,
    );
    await queryRunner.query(`CREATE TYPE "inquiries_contact_type_enum" AS ENUM ('EMAIL','PHONE')`);
    await queryRunner.query(`
      CREATE TABLE "inquiries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "creativeText" character varying(48) NOT NULL,
        "brandName" character varying(23) NOT NULL,
        "linkUrl" character varying(2048),
        "depositAmountKrw" integer NOT NULL,
        "depositorName" character varying(40) NOT NULL,
        "contact" character varying(254) NOT NULL,
        "contactType" "inquiries_contact_type_enum" NOT NULL,
        "status" "inquiries_status_enum" NOT NULL DEFAULT 'RECEIVED',
        "pricePerImpressionKrwAtReceipt" integer NOT NULL,
        "campaignId" uuid,
        "note" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_inquiries" PRIMARY KEY ("id"),
        CONSTRAINT "CK_inquiries_deposit_positive" CHECK ("depositAmountKrw" > 0),
        CONSTRAINT "CK_inquiries_price_positive" CHECK ("pricePerImpressionKrwAtReceipt" > 0)
      )
    `);
    // 운영자 목록은 상태별 최신순으로 본다.
    await queryRunner.query(`CREATE INDEX "IX_inquiries_status_created" ON "inquiries" ("status", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "inquiries"`);
    await queryRunner.query(`DROP TYPE "inquiries_contact_type_enum"`);
    await queryRunner.query(`DROP TYPE "inquiries_status_enum"`);
  }
}
