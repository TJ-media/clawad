import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LegalDocument } from './legal-document.entity';
import { LegalDocumentsController } from './legal-documents.controller';
import { LegalDocumentsService } from './legal-documents.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([LegalDocument])],
  controllers: [LegalDocumentsController],
  providers: [LegalDocumentsService],
  exports: [LegalDocumentsService],
})
export class LegalModule {}
