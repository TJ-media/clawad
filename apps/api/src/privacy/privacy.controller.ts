import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrivacyService, WithdrawResult } from './privacy.service';

class WithdrawDto {
  /** 남은 확정 리워드를 포기하는 데 동의. 없으면 확정 리워드가 있을 때 탈퇴가 차단된다. */
  @IsOptional()
  @IsBoolean()
  forfeitConfirmedRewards?: boolean;
}

/** 이용자 권리 행사 (CLAW-28). userId는 세션에서 확정한다. */
@Controller('v1/me')
@UseGuards(JwtAuthGuard)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** 내 정보 조회·내보내기 (수집 항목 전체, 기계 판독 JSON). */
  @Get('export')
  export(@Req() req: AuthenticatedRequest): Promise<Record<string, unknown>> {
    return this.privacy.exportData(req.userId);
  }

  /** 탈퇴. 즉시 서비스 이용 중단 + 직접 식별자 파기·가명화. */
  @Delete()
  @HttpCode(HttpStatus.OK)
  withdraw(@Req() req: AuthenticatedRequest, @Body() dto: WithdrawDto): Promise<WithdrawResult> {
    return this.privacy.withdraw(req.userId, dto.forfeitConfirmedRewards ?? false);
  }
}
