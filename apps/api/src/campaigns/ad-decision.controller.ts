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
import { EntityManager } from 'typeorm';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { loadPolicy } from '../common/policy';
import { CampaignType } from '../entities/campaign.entity';
import { Machine, MachineStatus } from '../entities/machine.entity';
import { KillSwitchService } from '../events/kill-switch.service';
import { MACHINE_ID_PATTERN } from '../machines/dto';
import { AdDecisionService } from './ad-decision.service';
import { ServeTokenService } from './serve-token.service';
import { ClickService } from './click.service';

const CACHED_CAMPAIGN_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
// 비즈니스 상한이 아니라 헤더 파싱의 방어 한계다. 실제 캐시는 serveToken 정책 상한을 따른다.
const MAX_CACHED_CAMPAIGN_IDS = 64;

function parseCachedCampaignIds(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  const values = raw.split(',');
  if (
    values.length > MAX_CACHED_CAMPAIGN_IDS ||
    values.some((value) => !CACHED_CAMPAIGN_ID_PATTERN.test(value))
  ) {
    throw new BadRequestException({ error: 'INVALID_CACHED_CAMPAIGN_IDS' });
  }
  return [...new Set(values)];
}

function campaignTypesForRequest(rehearsalMode: string | undefined, userId: string): readonly CampaignType[] {
  if (rehearsalMode === undefined || rehearsalMode === '') return [CampaignType.PAID, CampaignType.HOUSE];
  if (rehearsalMode === CampaignType.TEST) {
    if (process.env.CLAWAD_TEST_REHEARSAL_ENABLED !== 'true') {
      throw new ForbiddenException({ error: 'TEST_REHEARSAL_DISABLED' });
    }
    const allowedUsers = (process.env.CLAWAD_TEST_REHEARSAL_USER_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
      throw new ForbiddenException({ error: 'TEST_REHEARSAL_FORBIDDEN' });
    }
    return [CampaignType.TEST];
  }
  throw new BadRequestException({ error: 'INVALID_REHEARSAL_MODE' });
}

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
    private readonly killSwitch: KillSwitchService,
  ) {}

  private async assertRegisteredMachine(manager: EntityManager, userId: string, machineId: string): Promise<void> {
    if (!MACHINE_ID_PATTERN.test(machineId)) {
      throw new BadRequestException({ error: 'INVALID_MACHINE_ID' });
    }
    const machine = await manager.findOne(Machine, { where: { userId, machineId } });
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
    @Headers('x-clawad-rehearsal-mode') rehearsalMode?: string,
  ): Promise<AdDecisionResponse> {
    return this.killSwitch.withAdsShared(async (manager) => {
      await this.assertRegisteredMachine(manager, req.userId, machineId);
      if (await this.killSwitch.isAdsKilled(manager, req.userId, machineId)) {
        throw new NotFoundException({ error: 'NO_ELIGIBLE_AD' });
      }

      // 특정 캠페인 switch는 그 후보만 제외하고 다음 PAID/HOUSE 후보를 찾는다.
      const excluded = new Set<string>();
      const now = new Date();
      const campaignTypes = campaignTypesForRequest(rehearsalMode, req.userId);
      let decision = await this.decision.decide(req.userId, now, excluded, manager, campaignTypes);
      while (decision && (await this.killSwitch.isAdsKilled(manager, req.userId, machineId, decision.campaignId))) {
        excluded.add(decision.campaignId);
        decision = await this.decision.decide(req.userId, now, excluded, manager, campaignTypes);
      }
      if (!decision) throw new NotFoundException({ error: 'NO_ELIGIBLE_AD' });

      const policy = loadPolicy();
      const billingEligible = decision.campaignType === CampaignType.PAID;
      const rewardEligible =
        decision.campaignType === CampaignType.PAID ||
        (decision.campaignType === CampaignType.HOUSE && Boolean(decision.rewardPolicyId));

      const { serveToken, expiresAt } = await this.serveToken.issue(
        {
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
        },
        Date.now(),
        manager,
      );
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
    });
  }

  /** 프리페치 여유 조회. 클라이언트가 리필 필요 여부를 판단할 때 쓴다. */
  @Get('prefetch-status')
  async prefetchStatus(
    @Req() req: AuthenticatedRequest,
    @Headers('x-clawad-machine-id') machineId: string,
    @Headers('x-clawad-campaign-ids') rawCampaignIds?: string,
  ): Promise<{
    unused: number;
    limit: number;
    needsRefill: boolean;
    paused: boolean;
    blockedCampaignIds: string[];
  }> {
    const cachedCampaignIds = parseCachedCampaignIds(rawCampaignIds);
    return this.killSwitch.withAdsShared(async (manager) => {
      await this.assertRegisteredMachine(manager, req.userId, machineId);
      const policy = loadPolicy().serveToken;
      const paused = await this.killSwitch.isAdsKilled(manager, req.userId, machineId);
      if (paused) {
        // Redis 상태를 읽지 않아도 클라이언트가 fail-closed로 캐시를 비울 수 있어야 한다.
        return {
          unused: 0,
          limit: policy.maxUnusedTokensPerMachine,
          needsRefill: false,
          paused: true,
          blockedCampaignIds: [],
        };
      }
      return {
        unused: await this.serveToken.unusedCount(machineId),
        limit: policy.maxUnusedTokensPerMachine,
        needsRefill: await this.serveToken.needsRefill(machineId),
        paused: false,
        blockedCampaignIds: await this.killSwitch.activeCampaignIds(manager, cachedCampaignIds),
      };
    });
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
    return this.killSwitch.withAdsShared(async (manager) => {
      await this.assertRegisteredMachine(manager, req.userId, machineId);
      return { revoked: await this.serveToken.revokeUnused(machineId) };
    });
  }
}
