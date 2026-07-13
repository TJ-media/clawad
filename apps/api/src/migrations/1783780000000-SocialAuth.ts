import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLAW-37 소셜 전용 인증:
 *  - identities_provider_enum에 KAKAO·NAVER를 추가한다. EMAIL·GITHUB 값은 legacy로 보존한다
 *    (공개 로그인만 비활성화하며 기존 행은 승인된 후속 migration 전까지 삭제하지 않는다).
 *  - (userId, provider) 유일 인덱스를 추가해 한 사용자가 provider당 하나의 identity만 갖게 한다.
 *
 * 주의(운영 선행조건): 이 인덱스는 같은 사용자에 동일 provider의 identity가 둘 이상 있으면 실패한다.
 * cutover 전에 환경별 legacy(EMAIL/GITHUB) 및 provider 중복 행을 집계·정리해야 한다
 * (docs/legal/secrets-and-backup.md 체크리스트, 이슈 [활성 공급자 정책]).
 */
export class SocialAuth1783780000000 implements MigrationInterface {
  name = 'SocialAuth1783780000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL 12+는 트랜잭션 안에서 ADD VALUE를 허용한다(같은 트랜잭션에서 새 값을 사용하지 않는 한).
    await queryRunner.query(`ALTER TYPE "identities_provider_enum" ADD VALUE IF NOT EXISTS 'KAKAO'`);
    await queryRunner.query(`ALTER TYPE "identities_provider_enum" ADD VALUE IF NOT EXISTS 'NAVER'`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_identities_user_provider" ON "identities" ("userId", "provider")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_identities_user_provider"`);
    // enum 값 제거는 PostgreSQL이 직접 지원하지 않고, legacy 데이터 보존 정책상 되돌리지 않는다.
  }
}
