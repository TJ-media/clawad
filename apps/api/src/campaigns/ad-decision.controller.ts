import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { loadPolicy } from '../common/policy';
import { CampaignType } from '../entities/campaign.entity';
import { Machine, MachineStatus } from '../entities/machine.entity';
import { MACHINE_ID_PATTERN } from '../machines/dto';
import { AdDecisionService } from './ad-decision.service';
import { ServeTokenService } from './serve-token.service';
import { ClickService } from './click.service';

/** CLAW-18 §4 스키마. 클라이언트는 이 번들을 표시 전에 프리페치해 캐시한다. */
export interface AdDecisionResponse {
  serveToken: string;
  expiresAt: number;
  ad: {
    campaignId: string;
    creativeId: string;
    text: string;
    brand: string;
    /** 시스템이 강제하는 표기. 소재가 스스로 붙이지 못한다 (CLAW-20). */
    label: '광고';
    campaignType: string;
  };
  minViewMs: number;
  clickUrl: string | null;
}

@Controller('v1/ad-decision')
@UseGuards(JwtAuthGuard)
export class AdDecisionController {
  constructor(
    private readonly decision: AdDecisionService,
    private readonly serveToken: ServeTokenService,
    private readonly clicks: ClickService,
    @InjectRepository(Machine) private readonly machines: Repository<Machine>,
  ) {}

  private async assertRegisteredMachine(userId: string, machineId: string): Promise<void> {
    if (!MACHINE_ID_PATTERN.test(machineId)) {
      throw new BadRequestException({ error: 'INVALID_MACHINE_ID' });
    }
    const machine = await this.machines.findOneBy({ userId, machineId });
    if (!machine) throw new NotFoundException({ error: 'MACHINE_NOT_REGISTERED' });
    if (machine.status !== MachineStatus.ACTIVE) {
      throw new ForbiddenException({ error: 'MACHINE_NOT_ACTIVE', status: machine.status });
    }
  }

  /**
   * 등록된 기기용 광고 + serveToken을 발급한다.
   * userId는 인증 세션에서 서버가 확정한다. 요청 파라미터의 userId를 받지 않는다.
   */
  @Get()
  async decide(
    @Req() req: AuthenticatedRequest,
    @Headers('x-clawad-machine-id') machineId: string,
  ): Promise<AdDecisionResponse> {
    await this.assertRegisteredMachine(req.userId, machineId);

    const decision = await this.decision.decide(req.userId);
    if (!decision) throw new NotFoundException({ error: 'NO_ELIGIBLE_AD' });
    const policy = loadPolicy();
    const billingEligible = decision.campaignType === CampaignType.PAID;
    const rewardEligible =
      decision.campaignType === CampaignType.PAID ||
      (decision.campaignType === CampaignType.HOUSE && Boolean(decision.rewardPolicyId));

    const { serveToken, expiresAt } = await this.serveToken.issue({
      campaignId: decision.campaignId,
      creativeId: decision.creativeId,
      userId: req.userId,
      machineId,
      campaignType: decision.campaignType,
      policySnapshot: {
        policyVersion: policy.version,
        rewardPolicyId: decision.rewardPolicyId,
        billingEligible,
        rewardEligible,
        pricePerImpressionKrw: decision.pricePerImpressionKrw,
        rewardPerThousandAcceptedImpressions: policy.reward.rewardPerThousandAcceptedImpressions,
        minViewMs: policy.impression.minViewMs,
        concurrentToleranceMs: policy.impression.concurrentToleranceMs,
        timeWindowToleranceMs: policy.impression.timeWindowToleranceMs,
        maxContinuousSessionMs: policy.abuse.maxContinuousSessionMs,
        continuousSessionMaxGapMs: policy.abuse.continuousSessionMaxGapMs,
        dailyAcceptedImpressionLimit: policy.reward.dailyAcceptedImpressionLimit,
        dailyRewardLimit: policy.reward.dailyRewardLimit,
        perCampaignDailyImpressionLimit: policy.frequency.perCampaignDailyImpressionLimit,
        advertiserDailyImpressionLimit: decision.advertiserDailyImpressionLimit,
      },
    });
    const clickToken = decision.landingUrl
      ? this.clicks.issue({
          campaignId: decision.campaignId,
          creativeId: decision.creativeId,
          userId: req.userId,
          machineId,
          landingUrl: decision.landingUrl,
        })
      : null;

    return {
      serveToken,
      expiresAt,
      ad: {
        campaignId: decision.campaignId,
        creativeId: decision.creativeId,
        text: decision.text,
        brand: decision.brand,
        label: '광고',
        campaignType: decision.campaignType,
      },
      minViewMs: policy.impression.minViewMs,
      clickUrl: clickToken ? `${req.protocol}://${req.get('host')}/v1/click/${clickToken}` : null,
    };
  }

  /** 프리페치 여유 조회. 클라이언트가 리필 필요 여부를 판단할 때 쓴다. */
  @Get('prefetch-status')
  async prefetchStatus(
    @Req() req: AuthenticatedRequest,
    @Headers('x-clawad-machine-id') machineId: string,
  ): Promise<{ unused: number; limit: number; needsRefill: boolean }> {
    await this.assertRegisteredMachine(req.userId, machineId);
    const policy = loadPolicy().serveToken;
    return {
      unused: await this.serveToken.unusedCount(machineId),
      limit: policy.maxUnusedTokensPerMachine,
      needsRefill: await this.serveToken.needsRefill(machineId),
    };
  }

  /**
   * 로컬 캐시 유실 복구용. 미동기화 이벤트 후보가 없을 때만 클라이언트가 호출한다.
   * 멱등이며, 폐기된 토큰은 재사용할 수 없다.
   */
  @Delete('prefetched-tokens')
  @HttpCode(HttpStatus.OK)
  async revokePrefetched(
    @Req() req: AuthenticatedRequest,
    @Headers('x-clawad-machine-id') machineId: string,
  ): Promise<{ revoked: number }> {
    await this.assertRegisteredMachine(req.userId, machineId);
    return { revoked: await this.serveToken.revokeUnused(machineId) };
  }
}
