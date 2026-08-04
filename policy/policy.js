'use strict';
// 클로애드 정책 설정 로더·검증기·계산기 (CLAW-12).
// 리워드 단가·상한·간격·기기·토큰 정책을 코드에 흩뿌리지 않고 이 모듈로만 다룬다.
// 모든 소비자(서버/표시용 추정)는 여기서 값을 읽는다. 값은 reward-policy.default.json
// (또는 운영 시 서버 정책 테이블)에서 로드하며, 코드 수정 없이 값만 바꿔 적용할 수 있다.
const fs = require('fs');
const path = require('path');

// 모듈 로드 시점이 아니라 호출 시점에 읽는다. 로드 후 환경변수를 바꾸는 테스트·운영 전환에서
// 오버라이드가 조용히 무시되면 안 된다 (CLAW-102).
function defaultFile() {
  return process.env.CLAWAD_POLICY_FILE || path.join(__dirname, 'reward-policy.default.json');
}

function loadPolicy(file) {
  const raw = fs.readFileSync(file || defaultFile(), 'utf8').replace(/^﻿/, '');
  const p = JSON.parse(raw);
  validatePolicy(p);
  return p;
}

/**
 * 정책일 일자 키 (CLAW-151). 일일 상한(FrequencyService)·상한 초과 판정(EventsService)·
 * 적립 배치(RewardService)·리포트 버킷(AnalyticsService)이 **모두 이 함수 하나**를 쓴다.
 *
 * 예전에는 네 곳이 각자 toISOString().slice(0, 10)을 불렀다. 한쪽만 옮기면 "상한은 안 걸렸는데
 * 적립은 안 되는" 구간이 생기므로, 경계를 바꿀 때 한 군데만 고치면 전부 따라오게 만든다.
 *
 * UTC 시각에 shiftMinutes를 더한 뒤 날짜만 뗀다. 기본값 180이면 경계가 한국시간 06:00이고
 * 라벨은 그 구간이 속한 **한국 날짜**다 — [KST 8/4 06:00, KST 8/5 06:00) 구간의 키는 '2026-08-04'.
 * 0이면 UTC 자정 경계로, 이 값을 도입하기 전 동작과 같다.
 *
 * SQL 쪽(상한 창·가입자 집계)은 같은 계산을 date_trunc/make_interval로 표현한다. 함께 고친다.
 */
function policyDayKey(at, shiftMinutes) {
  return new Date(at.getTime() + shiftMinutes * 60000).toISOString().slice(0, 10);
}

/**
 * 다음 정책일 경계 = 지금 정책일이 끝나고 일일 상한이 초기화되는 시각 (CLAW-151).
 * 클라이언트가 "언제 다시 받을 수 있는지"를 안내하는 데 쓴다 (CLAW-150 dailyCapResetsAt).
 */
function nextPolicyDayStart(at, shiftMinutes) {
  const shiftMs = shiftMinutes * 60000;
  const shifted = new Date(at.getTime() + shiftMs);
  const nextShiftedMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1
  );
  return new Date(nextShiftedMidnight - shiftMs);
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

  // 정책일 경계 (CLAW-151). posInt를 쓰지 않는 이유는 **0이 유효한 값**이기 때문이다 —
  // 0은 UTC 자정 경계이고, 그게 이 값을 도입하기 전의 동작이다. 1440분(하루) 이상이면
  // 경계 이동이 아니라 날짜 자체를 밀어버리므로 막는다.
  if (
    !Number.isInteger(reward.policyDayShiftMinutes) ||
    reward.policyDayShiftMinutes < 0 ||
    reward.policyDayShiftMinutes >= 1440
  ) {
    throw new Error(
      `정책값 reward.policyDayShiftMinutes은(는) 0 이상 1440 미만의 정수여야 함: ${reward.policyDayShiftMinutes}`
    );
  }

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

// 설문 완료 리워드 정책 (CLAW-97). 노출 기반 적립과 별개 축이므로 validateRewardPolicy의
// 일일 상한·최소 교환 도달일 불변식에 섞지 않는다. 설문 리워드는 일일 상한을 소비하지도,
// 상한 소진 여부에 영향을 받지도 않는다.
function validateSurveyPolicy(survey) {
  if (!survey || typeof survey !== 'object') throw new Error('정책값 survey 섹션이 필요함');
  if (typeof survey.version !== 'string' || !survey.version.trim()) {
    throw new Error(`정책값 survey.version은(는) 비어 있지 않은 문자열이어야 함: ${survey.version}`);
  }
  if (!Number.isInteger(survey.completionRewardPoints) || survey.completionRewardPoints <= 0) {
    throw new Error(`정책값 survey.completionRewardPoints은(는) 양의 정수여야 함: ${survey.completionRewardPoints}`);
  }
}

function validatePolicy(p) {
  if (!p || typeof p !== 'object') throw new Error('정책 객체가 필요함');
  validateRewardPolicy(p.reward || {});
  validateSurveyPolicy(p.survey);
  const posInt = (v, name) => {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`정책값 ${name}은(는) 양의 정수여야 함: ${v}`);
  };
  posInt(p.device.maxDevicesPerAccount, 'device.maxDevicesPerAccount');
  posInt(p.impression.minViewMs, 'impression.minViewMs');
  posInt(p.impression.concurrentToleranceMs, 'impression.concurrentToleranceMs');
  posInt(p.impression.timeWindowToleranceMs, 'impression.timeWindowToleranceMs');
  posInt(p.impression.maxUploadDelayMs, 'impression.maxUploadDelayMs');
  // CLI 클라이언트 런타임 값 (CLAW-134). statusLine 섹션은 광고 창구를 오버레이로 일원화하며
  // 제거했다 — 우리는 Claude Code의 statusLine 슬롯을 점유하지 않는다.
  if (!p.client || typeof p.client !== 'object') throw new Error('정책값 client 섹션이 필요함');
  posInt(p.client.hookHealthCheckTimeoutMs, 'client.hookHealthCheckTimeoutMs');
  posInt(p.activity.staleActiveMs, 'activity.staleActiveMs');
  posInt(p.activity.workStateRetentionMs, 'activity.workStateRetentionMs');
  if (p.activity.staleActiveMs < p.impression.minViewMs) {
    throw new Error('정책값 activity.staleActiveMs는 impression.minViewMs보다 작을 수 없습니다.');
  }
  // 활동 기록을 활성 판정 기준보다 빨리 지우면 아직 열려 있는 구간을 잃는다.
  if (p.activity.workStateRetentionMs < p.activity.staleActiveMs) {
    throw new Error('정책값 activity.workStateRetentionMs는 activity.staleActiveMs보다 작을 수 없습니다.');
  }
  // 오버레이 서피스 정책 (CLAW-86). 유일한 광고 표시 창구다 (CLAW-134). 섹션이 없으면 즉시
  // 실패한다 — 정책 누락을 기본값으로 넘겨짚지 않는다. 단가·상한·minViewMs·frequency는
  // 서피스별로 분리하지 않으므로 overlay 섹션에 두지 않는다.
  if (!p.overlay || typeof p.overlay !== 'object') {
    throw new Error('정책값 overlay 섹션이 필요함 — 기본값으로 폴백하지 않음');
  }
  posInt(p.overlay.adRotateMs, 'overlay.adRotateMs');
  posInt(p.overlay.adGapMs, 'overlay.adGapMs');
  posInt(p.overlay.idleThresholdMs, 'overlay.idleThresholdMs');
  posInt(p.overlay.maxWidthPx, 'overlay.maxWidthPx');
  if (p.overlay.adRotateMs < p.impression.minViewMs) {
    throw new Error('정책값 overlay.adRotateMs는 impression.minViewMs보다 작을 수 없습니다.');
  }
  // 인정 구간 사이 간격 (CLAW-135). 서버는 동시 노출 판정 구간을 concurrentToleranceMs만큼
  // 양쪽으로 넓히므로, 간격이 그 이하면 연속 노출이 서로 CONCURRENT_USER_IMPRESSION으로 걸린다.
  if (p.overlay.adGapMs <= p.impression.concurrentToleranceMs) {
    throw new Error('정책값 overlay.adGapMs는 impression.concurrentToleranceMs보다 커야 합니다.');
  }
  // 간격을 뺀 인정 구간이 최소 시청 시간에 못 미치면 어떤 노출도 인정되지 않는다.
  if (p.overlay.adRotateMs - p.overlay.adGapMs < p.impression.minViewMs) {
    throw new Error('정책값 overlay.adRotateMs - overlay.adGapMs는 impression.minViewMs보다 작을 수 없습니다.');
  }
  if (p.overlay.idleThresholdMs < p.impression.minViewMs) {
    throw new Error('정책값 overlay.idleThresholdMs는 impression.minViewMs보다 작을 수 없습니다.');
  }
  // 오버레이 노출 이벤트 스풀 위생 (CLAW-90). 오버레이는 표시 사실만 스풀에 남기고 clawad가 수거한다.
  posInt(p.overlay.eventSpoolMaxFiles, 'overlay.eventSpoolMaxFiles');
  posInt(p.overlay.eventSpoolRetentionMs, 'overlay.eventSpoolRetentionMs');
  // 보존기간이 광고 교체 주기보다 짧으면 수거되기 전에 폐기돼 표시 사실이 유실된다.
  if (p.overlay.eventSpoolRetentionMs < p.overlay.adRotateMs) {
    throw new Error('정책값 overlay.eventSpoolRetentionMs는 overlay.adRotateMs보다 작을 수 없습니다.');
  }
  // 서버가 받아주는 업로드 지연 한도를 넘겨 보관하면 거절될 이벤트를 계속 들고 있게 된다.
  if (p.overlay.eventSpoolRetentionMs > p.impression.maxUploadDelayMs) {
    throw new Error('정책값 overlay.eventSpoolRetentionMs는 impression.maxUploadDelayMs보다 클 수 없습니다.');
  }
  // 활동 기록 정리와 스풀 수거의 관계 (CLAW-143). 스풀은 보존기간만큼 수거되지 않은 채 남을 수
  // 있고, 수거는 그때 work-state의 활성 구간과 교집합을 내 인정 여부를 정한다. 활동 기록을 먼저
  // 지우면 인정될 노출이 BELOW_MIN_VIEW로 조용히 사라진다 — 사용자는 이유를 알 수 없다.
  if (p.activity.workStateRetentionMs < p.overlay.eventSpoolRetentionMs) {
    throw new Error('정책값 activity.workStateRetentionMs는 overlay.eventSpoolRetentionMs보다 작을 수 없습니다.');
  }
  posInt(p.abuse.maxContinuousSessionMs, 'abuse.maxContinuousSessionMs');
  posInt(p.abuse.continuousSessionMaxGapMs, 'abuse.continuousSessionMaxGapMs');
  if (p.abuse.continuousSessionMaxGapMs >= p.abuse.maxContinuousSessionMs) {
    throw new Error('정책값 abuse.continuousSessionMaxGapMs는 maxContinuousSessionMs보다 작아야 함');
  }
  posInt(p.serveToken.ttlMs, 'serveToken.ttlMs');
  posInt(p.serveToken.maxUnusedTokensPerMachine, 'serveToken.maxUnusedTokensPerMachine');
  // 리필 지평은 "곧 만료될 토큰은 가용분으로 세지 않는" 창이다. 토큰 수명보다 크면
  // 항상 리필이 걸려 발급 상한만 소모하므로 ttl보다 작아야 한다 (CLAW-106).
  posInt(p.serveToken.refillHorizonMs, 'serveToken.refillHorizonMs');
  if (p.serveToken.refillHorizonMs >= p.serveToken.ttlMs) {
    throw new Error('정책값 serveToken.refillHorizonMs는 serveToken.ttlMs보다 작아야 합니다.');
  }
  posInt(p.click.tokenTtlMs, 'click.tokenTtlMs');
}

module.exports = {
  loadPolicy,
  validatePolicy,
  validateRewardPolicy,
  validateSurveyPolicy,
  pointsForImpressions,
  maxDailyAccrual,
  expectedDaysToMinRedemption,
  policyDayKey,
  nextPolicyDayStart,
  defaultFile,
};
