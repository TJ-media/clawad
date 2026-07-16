import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-73 교환 요청 멱등성:
 *  - redemptions에 클라이언트 생성 교환 의도 키(idempotencyKey, uuid)를 추가한다.
 *  - UNIQUE(userId, idempotencyKey)를 부분 인덱스로 강제해 같은 의도의 재시도가
 *    두 번째 주문·추가 REDEEM_DEBIT을 만들 수 없게 한다.
 *  - 키 도입 이전 레거시 행과 키 미전송(CLI 등) 요청은 NULL이며, 부분 인덱스라 NULL 다중을 허용한다.
 */
export class RedemptionIdempotency1783830000000 implements MigrationInterface {
  name = 'RedemptionIdempotency1783830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "redemptions" ADD COLUMN "idempotencyKey" uuid`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_redemptions_user_idempotency"
       ON "redemptions" ("userId", "idempotencyKey")
       WHERE "idempotencyKey" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_redemptions_user_idempotency"`);
    await queryRunner.query(`ALTER TABLE "redemptions" DROP COLUMN "idempotencyKey"`);
  }
}
