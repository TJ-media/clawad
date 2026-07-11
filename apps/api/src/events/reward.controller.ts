import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { RewardService, RewardSummary } from './reward.service';

/** 사용자 리워드 조회 (CLAW-5). userId는 세션에서 확정한다. */
@Controller('v1/rewards')
@UseGuards(JwtAuthGuard)
export class RewardController {
  constructor(private readonly rewards: RewardService) {}

  @Get()
  async summary(@Req() req: AuthenticatedRequest): Promise<RewardSummary> {
    return this.rewards.summary(req.userId);
  }

  @Get('history')
  async history(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ): Promise<RewardLedgerEntry[]> {
    const n = limit ? Number(limit) : 100;
    return this.rewards.history(req.userId, Number.isFinite(n) && n > 0 ? n : 100);
  }
}
