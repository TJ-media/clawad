import { MigrationInterface, QueryRunner } from 'typeorm';

/** CLAW-44: 거절 후 재투영에도 발급 시점 리워드 자격을 복원한다. */
export class RewardEligibilitySnapshot1783811000000 implements MigrationInterface {
  name = 'RewardEligibilitySnapshot1783811000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "rewardEligibleSnapshot" boolean`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "impression_events" DROP COLUMN "rewardEligibleSnapshot"`);
  }
}
