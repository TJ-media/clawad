import { MigrationInterface, QueryRunner } from 'typeorm';

export class LegalDocuments1783813000000 implements MigrationInterface {
  name = 'LegalDocuments1783813000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "legal_documents_type_enum" AS ENUM('TERMS_OF_SERVICE', 'PRIVACY_POLICY')`);
    await queryRunner.query(`
      CREATE TABLE "legal_documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "type" "legal_documents_type_enum" NOT NULL,
        "version" character varying(32) NOT NULL,
        "publicUrl" character varying(512) NOT NULL,
        "effectiveAt" date NOT NULL,
        "active" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_legal_documents" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_legal_documents_type_version" ON "legal_documents" ("type", "version")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_legal_documents_active_type" ON "legal_documents" ("type") WHERE "active" = true`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "legal_documents"`);
    await queryRunner.query(`DROP TYPE "legal_documents_type_enum"`);
  }
}
