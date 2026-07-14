import { MigrationInterface, QueryRunner } from 'typeorm';

/** CLAW-43: 계정의 UTC 일일 유효 노출 원장 집계를 위한 복합 인덱스. */
export class AccountCapLedgerIndex1783800000000 implements MigrationInterface {
  name = 'AccountCapLedgerIndex1783800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_impression_events_user_received" ON "impression_events" ("userId", "receivedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_impression_events_user_received"`);
  }
}
