import { Controller, Get } from '@nestjs/common';
import { LegalDocumentsService } from './legal-documents.service';

@Controller('v1/legal/documents')
export class LegalDocumentsController {
  constructor(private readonly legal: LegalDocumentsService) {}

  @Get()
  list(): Promise<Record<string, unknown>> {
    return this.legal.publicBundle();
  }
}
