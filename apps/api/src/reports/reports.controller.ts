import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportSubmitResult, ReportView, ReportsService } from './reports.service';

class SubmitReportDto {
  /** 이용자가 작성한 본문. 길이 상한은 서버 정책값으로 다시 검증한다. */
  @IsString()
  @MaxLength(10000)
  body: string;

  /** 답변 회신용 이메일 (선택, CLAW-233). 넣으면 동의도 함께 와야 한다. */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  replyEmail?: string;

  @IsOptional()
  @IsBoolean()
  replyEmailConsent?: boolean;
}

/**
 * 이용자 제보 (CLAW-234). userId는 세션에서 확정한다 — 요청 본문의 자가신고를 신뢰하지 않는다.
 * 익명 제출을 열지 않는다. 답변과 포상 지급 대상을 특정해야 하고, 로그인 없이 열면 스팸이 온다.
 */
@Controller('v1/reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** 화면이 쓸 입력 상한·정책값. 숫자를 화면에 하드코딩하지 않기 위해 서버가 내려준다. */
  @Get('limits')
  limits(): { maxBodyLength: number; dailySubmitLimit: number; maxRewardPoints: number } {
    return this.reports.limits();
  }

  /** 내 제보 목록 + 안 읽은 답변 수. */
  @Get()
  listMine(@Req() req: AuthenticatedRequest): Promise<{ reports: ReportView[]; unread: number }> {
    return this.reports.listMine(req.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  submit(@Req() req: AuthenticatedRequest, @Body() dto: SubmitReportDto): Promise<ReportSubmitResult> {
    return this.reports.submit(req.userId, dto.body, dto.replyEmail, dto.replyEmailConsent);
  }

  /** 답변 읽음 처리. 기기가 바뀌어도 유지되도록 서버에 남긴다. */
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ reportId: string; read: boolean }> {
    return this.reports.markRead(req.userId, id);
  }
}
