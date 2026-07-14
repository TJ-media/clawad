import { MigrationInterface, QueryRunner } from 'typeorm';

/** CLAW-44: 결정 시점 정책 스냅샷과 원장 추적 필드. */
export class PolicySnapshots1783810000000 implements MigrationInterface {
  name = 'PolicySnapshots1783810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "decision_policy_snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "contentHash" character varying(64) NOT NULL,
        "policyVersion" integer NOT NULL,
        "snapshot" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_decision_policy_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_decision_policy_snapshots_hash" UNIQUE ("contentHash")
      )
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION decision_policy_snapshots_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'decision_policy_snapshots는 append-only입니다';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_decision_policy_snapshots_append_only"
      BEFORE UPDATE OR DELETE ON "decision_policy_snapshots"
      FOR EACH ROW EXECUTE FUNCTION decision_policy_snapshots_append_only()
    `);

    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "policySnapshotId" uuid`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "policyVersion" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "rewardPolicyId" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "billingEligibleSnapshot" boolean`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "pricePerImpressionKrwSnapshot" bigint`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "rewardPerThousandSnapshot" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "minViewMsSnapshot" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "concurrentToleranceMsSnapshot" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "timeWindowToleranceMsSnapshot" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "dailyAcceptedLimitSnapshot" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "dailyRewardLimitSnapshot" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "campaignDailyLimitSnapshot" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD COLUMN "advertiserDailyLimitSnapshot" integer`);
    await queryRunner.query(`ALTER TABLE "impression_events" ADD CONSTRAINT "FK_impression_policy_snapshot" FOREIGN KEY ("policySnapshotId") REFERENCES "decision_policy_snapshots"("id") ON DELETE RESTRICT`);

    for (const table of ['billing_ledger', 'reward_ledger']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "policySnapshotId" uuid`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "policyVersion" integer`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "rewardPolicyId" character varying(64)`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD CONSTRAINT "FK_${table}_policy_snapshot" FOREIGN KEY ("policySnapshotId") REFERENCES "decision_policy_snapshots"("id") ON DELETE RESTRICT`);
    }
    await queryRunner.query(`ALTER TABLE "billing_ledger" ADD COLUMN "unitPriceKrw" bigint`);
    await queryRunner.query(`ALTER TABLE "reward_ledger" ADD COLUMN "rewardPerThousandSnapshot" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reward_ledger" DROP COLUMN "rewardPerThousandSnapshot", DROP COLUMN "rewardPolicyId", DROP COLUMN "policyVersion", DROP COLUMN "policySnapshotId"`);
    await queryRunner.query(`ALTER TABLE "billing_ledger" DROP COLUMN "unitPriceKrw", DROP COLUMN "rewardPolicyId", DROP COLUMN "policyVersion", DROP COLUMN "policySnapshotId"`);
    await queryRunner.query(`ALTER TABLE "impression_events" DROP COLUMN "advertiserDailyLimitSnapshot", DROP COLUMN "campaignDailyLimitSnapshot", DROP COLUMN "dailyRewardLimitSnapshot", DROP COLUMN "dailyAcceptedLimitSnapshot", DROP COLUMN "timeWindowToleranceMsSnapshot", DROP COLUMN "concurrentToleranceMsSnapshot", DROP COLUMN "minViewMsSnapshot", DROP COLUMN "rewardPerThousandSnapshot", DROP COLUMN "pricePerImpressionKrwSnapshot", DROP COLUMN "billingEligibleSnapshot", DROP COLUMN "rewardPolicyId", DROP COLUMN "policyVersion", DROP COLUMN "policySnapshotId"`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_decision_policy_snapshots_append_only" ON "decision_policy_snapshots"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS decision_policy_snapshots_append_only()`);
    await queryRunner.query(`DROP TABLE "decision_policy_snapshots"`);
  }
}
