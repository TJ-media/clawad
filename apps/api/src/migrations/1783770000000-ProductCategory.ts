import { MigrationInterface, QueryRunner } from 'typeorm';

/** CLAW-36: products에 샵 카테고리 필터용 category 컬럼 추가. */
export class ProductCategory1783770000000 implements MigrationInterface {
  name = 'ProductCategory1783770000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "category" character varying(20)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "category"`);
  }
}
