import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-74 발송 이메일 수집:
 *  - redemptions에 발송 이메일 스냅샷(deliveryEmail)을 추가한다. 알파 쿠폰 수동 발송 대상 주소다.
 *  - 로그인 식별자(users.email)와 분리된 컬럼이며 UNIQUE를 두지 않는다(발송 목적, 중복 허용).
 *  - 수집·이용 동의 시각(deliveryEmailConsentAt)을 함께 둔다 — 이메일 파기 후에도 동의 증적으로 남긴다.
 *  - 레거시·미입력 교환은 NULL이다. 발송·취소·실패 종결 또는 탈퇴 시 deliveryEmail을 NULL로 파기한다.
 */
export class RedemptionDeliveryEmail1783840000000 implements MigrationInterface {
  name = 'RedemptionDeliveryEmail1783840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "redemptions" ADD COLUMN "deliveryEmail" character varying(320)`);
    await queryRunner.query(`ALTER TABLE "redemptions" ADD COLUMN "deliveryEmailConsentAt" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "redemptions" DROP COLUMN "deliveryEmailConsentAt"`);
    await queryRunner.query(`ALTER TABLE "redemptions" DROP COLUMN "deliveryEmail"`);
  }
}
