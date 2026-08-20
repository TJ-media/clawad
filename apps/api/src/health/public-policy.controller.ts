import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadPolicy } from '../common/policy';

/**
 * 이용자용 공개 정책. **광고주 단가를 여기 넣지 않는다** (CLAW-249) — 이 응답은 리워드 샵이
 * 읽으므로, 노출 단가를 실으면 사용자 화면 payload에 적립액과 차감액이 나란히 담겨 둘의 관계가
 * 그대로 드러난다. 광고 신청 화면은 전용 경로(`GET /v1/inquiries/limits`)로 받아 간다.
 */
@Controller('v1/policy')
export class PublicPolicyController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  current() {
    const policy = loadPolicy();
    return {
      policyVersion: policy.version,
      releaseStage: this.config.get<string>('PUBLIC_RELEASE_STAGE', 'alpha'),
      reward: {
        rewardPerThousandAcceptedImpressions: policy.reward.rewardPerThousandAcceptedImpressions,
        dailyAcceptedImpressionLimit: policy.reward.dailyAcceptedImpressionLimit,
        dailyRewardLimit: policy.reward.dailyRewardLimit,
        minimumRedemptionPoints: policy.reward.minimumRedemptionPoints,
      },
    };
  }
}
