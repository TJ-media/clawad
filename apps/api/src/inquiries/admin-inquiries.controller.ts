import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from '../admin/admin.guard';
import { AdminRole } from '../admin/admin-user.entity';
import { AuditInterceptor } from '../admin/audit.interceptor';
import { Roles } from '../admin/roles.decorator';
import { InquiryStatus } from './inquiry.entity';
import { AdminInquiryView, InquiriesService } from './inquiries.service';

class UpdateInquiryStatusDto {
  @IsEnum(InquiryStatus)
  status: InquiryStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/**
 * 광고 신청 운영 (CLAW-249). 입금 확인과 상태 전이를 사람이 처리한다 — 개인 계좌라 자동 대사가 없다.
 *
 * 목록의 `contact`는 마스킹해 내려간다. 원문 열람은 감사에 남는 POST로만 연다 —
 * `admin-reports.controller.ts`가 답변 이메일에 쓰는 것과 같은 기준이다(감사 인터셉터는 GET을
 * 기록하지 않으므로 GET으로 두면 개인정보 열람이 흔적 없이 일어난다).
 * `depositorName`은 마스킹하지 않는다 — 은행 입금 내역과 대조하는 키라 목록에서 바로 보여야 한다.
 */
@Controller('internal/v1')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminInquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}

  @Get('inquiries')
  @Roles(AdminRole.REVIEWER)
  list(): Promise<AdminInquiryView[]> {
    return this.inquiries.listForAdmin();
  }

  /** 알림을 보내려고 연락처 원문을 볼 때. 감사에 남는다. */
  @Post('inquiries/:id/contact')
  @Roles(AdminRole.SETTLER)
  @HttpCode(HttpStatus.OK)
  revealContact(@Param('id', ParseUUIDPipe) id: string): Promise<{ inquiryId: string; contact: string }> {
    return this.inquiries.revealContact(id);
  }

  @Post('inquiries/:id/status')
  @Roles(AdminRole.SETTLER)
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInquiryStatusDto,
  ): Promise<AdminInquiryView> {
    return this.inquiries.updateStatus(id, dto.status, dto.note);
  }
}
