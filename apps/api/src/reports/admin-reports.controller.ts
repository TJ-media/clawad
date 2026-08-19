import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { AdminGuard } from '../admin/admin.guard';
import { AdminRole } from '../admin/admin-user.entity';
import { AuditInterceptor } from '../admin/audit.interceptor';
import { Roles } from '../admin/roles.decorator';
import { AdminReportView, ReportReplyResult, ReportsService } from './reports.service';

class ReplyReportDto {
  @IsString()
  @Length(1, 10000)
  reply: string;

  /**
   * 포상 포인트. **운영자가 건별로 정한다.** 생략하면 포상 없이 답변만 나간다.
   * 상한은 서버 정책값(bugReport.maxRewardPoints)이 강제한다.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  rewardPoints?: number;
}

/**
 * 이용자 제보 운영 (CLAW-234). 답변과 선택적 포상을 처리한다.
 *
 * 포상은 원장에 append되고 원장은 수정·삭제할 수 없다 (rules §4) — 그래서 감사 인터셉터를 건다.
 */
@Controller('internal/v1')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** 화면이 포상 상한을 표시하는 데 쓴다. 숫자를 화면에 하드코딩하지 않는다 (rules §5). */
  @Get('reports/limits')
  @Roles(AdminRole.REVIEWER)
  limits(): { maxBodyLength: number; dailySubmitLimit: number; maxRewardPoints: number } {
    return this.reports.limits();
  }

  /** 제보 목록. 미답변이 위로 온다. */
  @Get('reports')
  @Roles(AdminRole.REVIEWER)
  list(): Promise<AdminReportView[]> {
    return this.reports.listForAdmin();
  }

  /**
   * 답변 이메일 원문. 수동 발송용이며 목록에는 마스킹만 내려간다.
   *
   * **GET이 아니라 POST다.** 감사 인터셉터가 조회(GET)를 기록하지 않으므로(audit.interceptor.ts:23)
   * GET으로 두면 개인정보 원문 열람이 아무 흔적 없이 일어난다. 목록에서 마스킹을 뗀 근거가
   * "열람이 감사에 남는다"인 이상, 이 경로는 기록되는 쪽이어야 한다.
   */
  @Post('reports/:id/email')
  @Roles(AdminRole.SETTLER)
  @HttpCode(HttpStatus.OK)
  revealEmail(@Param('id', ParseUUIDPipe) id: string): Promise<{ reportId: string; replyEmail: string | null }> {
    return this.reports.revealEmail(id);
  }

  /** 답변 + 선택적 포상. 같은 제보에 두 번 답변하지 않는다. */
  @Post('reports/:id/reply')
  @Roles(AdminRole.SETTLER)
  @HttpCode(HttpStatus.OK)
  reply(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplyReportDto,
  ): Promise<ReportReplyResult> {
    return this.reports.reply(id, dto.reply, dto.rewardPoints);
  }
}
