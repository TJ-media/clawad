import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadPolicy } from '../common/policy';

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
