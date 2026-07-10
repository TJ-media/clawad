'use strict';
// 캠페인 유형별 과금·리워드 자격 (CLAW-6 정책 문서의 §유료·하우스·테스트 구분).
// PAID: 광고주 과금 O, 정책에 따라 리워드 O
// HOUSE: 과금 X, 기본 리워드 X (명시적 프로모션 정책이 있을 때만 리워드)
// TEST: 과금 X, 실제 리워드 X (테스트 원장으로만 분리)
//
// 하우스·테스트 광고가 광고주 매출이나 미지급 리워드 부채를 만들지 않도록 자격을 강제한다.

const CAMPAIGN_TYPES = ['PAID', 'HOUSE', 'TEST'];

// campaign: { type, rewardPolicyId?, houseRewardOptIn? }
function eligibility(campaign) {
  const type = campaign && campaign.type;
  switch (type) {
    case 'PAID':
      return { billingEligible: true, rewardEligible: true, testOnly: false };
    case 'HOUSE':
      // 명시적 프로모션 리워드 정책(houseRewardOptIn + rewardPolicyId)이 있을 때만 리워드 허용.
      return {
        billingEligible: false,
        rewardEligible: Boolean(campaign.houseRewardOptIn && campaign.rewardPolicyId),
        testOnly: false,
      };
    case 'TEST':
      return { billingEligible: false, rewardEligible: false, testOnly: true };
    default:
      throw new Error(`알 수 없는 campaignType: ${type}`);
  }
}

module.exports = { eligibility, CAMPAIGN_TYPES };
