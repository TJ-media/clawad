import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-148: 설치 퍼널이 "노출이 한 건이라도 있는 기기" 집합을 구한다.
 * machineId 단독 인덱스가 없어 기존 인덱스(userId 선행·tokenJti)로는 이 조회를 탈 수 없었다 —
 * 기기 4,131·이벤트 93,595 표본에서 기기별 EXISTS가 14.5초 걸렸다.
 * 이 인덱스로 같은 조회가 15ms, 현재 쓰는 DISTINCT 집합 방식도 46ms → 19ms가 된다.
 */
export class ImpressionMachineIndex1783880000000 implements MigrationInterface {
  name = 'ImpressionMachineIndex1783880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_impression_events_machine" ON "impression_events" ("machineId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_impression_events_machine"`);
  }
}
