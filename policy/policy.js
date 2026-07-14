'use strict';
// 클로애드 정책 설정 로더·검증기·계산기 (CLAW-12).
// 리워드 단가·상한·간격·기기·토큰 정책을 코드에 흩뿌리지 않고 이 모듈로만 다룬다.
// 모든 소비자(서버/표시용 추정)는 여기서 값을 읽는다. 값은 reward-policy.default.json
// (또는 운영 시 서버 정책 테이블)에서 로드하며, 코드 수정 없이 값만 바꿔 적용할 수 있다.
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = process.env.CLAWAD_POLICY_FILE || path.join(__dirname, 'reward-policy.default.json');

function loadPolicy(file) {
  const raw = fs.readFileSync(file || DEFAULT_FILE, 'utf8').replace(/^﻿/, '');
  const p = JSON.parse(raw);
  validatePolicy(p);
  return p;
}

// 인정 노출 수 → 적립 포인트 (정수). 금액 계산은 항상 서버 정책값으로 한다.
function pointsForImpressions(reward, acceptedImpressions) {
  return Math.floor((acceptedImpressions * reward.rewardPerThousandAcceptedImpressions) / 1000);
}

// 정책상 하루에 이론적으로 쌓을 수 있는 최대 적립액.
function maxDailyAccrual(reward) {
  return pointsForImpressions(reward, reward.dailyAcceptedImpressionLimit);
}

// 최소 교환액에 도달하는 데 필요한 일수 (매일 상한까지 적립하는 이상적 사용자 기준).
function expectedDaysToMinRedemption(reward) {
  const perDay = Math.min(reward.dailyRewardLimit, maxDailyAccrual(reward));
  if (perDay <= 0) return Infinity;
  return Math.ceil(reward.minimumRedemptionPoints / perDay);
}

// 정책 불변식 검증. 위반 시 Error를 던진다 — 모순된 정책값이 배포되지 않게 한다.
function validateRewardPolicy(reward) {
  const posInt = (v, name) => {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`정책값 ${name}은(는) 양의 정수여야 함: ${v}`);
  };
  posInt(reward.rewardPerThousandAcceptedImpressions, 'rewardPerThousandAcceptedImpressions');
  posInt(reward.dailyAcceptedImpressionLimit, 'dailyAcceptedImpressionLimit');
  posInt(reward.dailyRewardLimit, 'dailyRewardLimit');
  posInt(reward.minimumRedemptionPoints, 'minimumRedemptionPoints');
  posInt(reward.maxReasonableRedemptionDays, 'maxReasonableRedemptionDays');

  // 불변식 1: 일일 리워드 상한은 계산 가능한 최대 적립액보다 크지 않아야 한다.
  const cap = maxDailyAccrual(reward);
  if (reward.dailyRewardLimit > cap) {
    throw new Error(
      `일일 리워드 상한(${reward.dailyRewardLimit}P)이 최대 적립 가능액(${cap}P)보다 큼 — 도달 불가능한 상한`
    );
  }

  // 불변식 2: 정상 사용자가 과도하게 긴 기간을 써야만 최소 교환에 도달하는 구조를 막는다.
  const days = expectedDaysToMinRedemption(reward);
  if (days > reward.maxReasonableRedemptionDays) {
    throw new Error(
      `최소 교환 도달 예상 ${days}일 > 허용 ${reward.maxReasonableRedemptionDays}일 — 최소 교환액/적립 정책 재검토 필요`
    );
  }
}

function validatePolicy(p) {
  if (!p || typeof p !== 'object') throw new Error('정책 객체가 필요함');
  validateRewardPolicy(p.reward || {});
  const posInt = (v, name) => {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`정책값 ${name}은(는) 양의 정수여야 함: ${v}`);
  };
  posInt(p.device.maxDevicesPerAccount, 'device.maxDevicesPerAccount');
  posInt(p.impression.minViewMs, 'impression.minViewMs');
  posInt(p.impression.concurrentToleranceMs, 'impression.concurrentToleranceMs');
  posInt(p.impression.timeWindowToleranceMs, 'impression.timeWindowToleranceMs');
  posInt(p.statusLine.refreshIntervalMs, 'statusLine.refreshIntervalMs');
  posInt(p.statusLine.adRotateMs, 'statusLine.adRotateMs');
  posInt(p.statusLine.rewardCacheStaleMs, 'statusLine.rewardCacheStaleMs');
  posInt(p.statusLine.originalCommandTimeoutMs, 'statusLine.originalCommandTimeoutMs');
  posInt(p.statusLine.clawadCommandTimeoutMs, 'statusLine.clawadCommandTimeoutMs');
  posInt(p.statusLine.healthCheckTimeoutMs, 'statusLine.healthCheckTimeoutMs');
  posInt(p.statusLine.maxOriginalOutputChars, 'statusLine.maxOriginalOutputChars');
  posInt(p.activity.staleActiveMs, 'activity.staleActiveMs');
  if (p.activity.staleActiveMs < p.impression.minViewMs) {
    throw new Error('정책값 activity.staleActiveMs는 impression.minViewMs보다 작을 수 없습니다.');
  }
  if (p.statusLine.refreshIntervalMs > p.statusLine.adRotateMs) {
    throw new Error('정책값 statusLine.refreshIntervalMs는 adRotateMs보다 작거나 같아야 합니다.');
  }
  if (p.statusLine.adRotateMs < p.impression.minViewMs) {
    throw new Error('정책값 statusLine.adRotateMs는 impression.minViewMs보다 작을 수 없습니다.');
  }
  posInt(p.abuse.maxContinuousSessionMs, 'abuse.maxContinuousSessionMs');
  posInt(p.abuse.continuousSessionMaxGapMs, 'abuse.continuousSessionMaxGapMs');
  if (p.abuse.continuousSessionMaxGapMs >= p.abuse.maxContinuousSessionMs) {
    throw new Error('정책값 abuse.continuousSessionMaxGapMs는 maxContinuousSessionMs보다 작아야 함');
  }
  posInt(p.serveToken.ttlMs, 'serveToken.ttlMs');
  posInt(p.serveToken.maxUnusedTokensPerMachine, 'serveToken.maxUnusedTokensPerMachine');
  posInt(p.click.tokenTtlMs, 'click.tokenTtlMs');
}

module.exports = {
  loadPolicy,
  validatePolicy,
  validateRewardPolicy,
  pointsForImpressions,
  maxDailyAccrual,
  expectedDaysToMinRedemption,
  DEFAULT_FILE,
};
