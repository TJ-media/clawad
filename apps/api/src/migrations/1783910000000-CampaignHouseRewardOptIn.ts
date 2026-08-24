import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-261: HOUSE 리워드 2요인 옵트인 복원.
 * server/lib/campaign.js는 houseRewardOptIn AND rewardPolicyId를 요구하지만 컬럼이 없어
 * 호출부가 Boolean(rewardPolicyId)로 합성했다 — AND 양변이 같은 값이라 단일 요인으로 붕괴.
 * 백필: 기존 HOUSE 캠페인 중 rewardPolicyId 보유분은 현 동작(리워드 적립)을 보존하기 위해
 * 옵트인으로 이관한다 (운영 시드 production-seed-house-campaigns.js가 의도한 상태).
 */
export class CampaignHouseRewardOptIn1783910000000 implements MigrationInterface {
  name = 'CampaignHouseRewardOptIn1783910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "campaigns" ADD "houseRewardOptIn" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `UPDATE "campaigns" SET "houseRewardOptIn" = true WHERE type = 'HOUSE' AND "rewardPolicyId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "houseRewardOptIn"`);
  }
}
