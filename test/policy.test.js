'use strict';
// 정책 설정 검증·계산 테스트 (CLAW-12)
const { test } = require('node:test');
const assert = require('node:assert');
const {
  loadPolicy,
  validatePolicy,
  validateRewardPolicy,
  validateSurveyPolicy,
  pointsForImpressions,
  maxDailyAccrual,
  expectedDaysToMinRedemption,
} = require('../policy/policy');

test('기본 정책은 불변식을 통과한다', () => {
  const p = loadPolicy();
  assert.ok(p.reward.rewardPerThousandAcceptedImpressions > 0);
  // 일일 리워드 상한 ≤ 최대 적립 가능액
  assert.ok(p.reward.dailyRewardLimit <= maxDailyAccrual(p.reward));
  // 최소 교환 도달일 ≤ 허용일
  assert.ok(expectedDaysToMinRedemption(p.reward) <= p.reward.maxReasonableRedemptionDays);
});

test('사용자 정책 문서의 현재 스냅샷은 서버 정책 단일 원본과 일치한다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = loadPolicy();
  const document = fs.readFileSync(path.join(__dirname, '..', 'docs', 'product', 'revenue-reward-policy.md'), 'utf8');
  for (const key of [
    'rewardPerThousandAcceptedImpressions',
    'dailyAcceptedImpressionLimit',
    'dailyRewardLimit',
    'minimumRedemptionPoints',
    'maxReasonableRedemptionDays',
  ]) {
    assert.match(document, new RegExp(`\\| ${key} \\| ${p.reward[key]} \\|`), `${key} 문서값이 정책과 일치해야 한다`);
  }
});

test('적립 계산: 인정 노출 1,000회당 rewardPerThousand', () => {
  const reward = { rewardPerThousandAcceptedImpressions: 300 };
  assert.strictEqual(pointsForImpressions(reward, 1000), 300);
  assert.strictEqual(pointsForImpressions(reward, 500), 150);
  assert.strictEqual(pointsForImpressions(reward, 1), 0); // 소량은 내림
});

test('일일 리워드 상한이 최대 적립액보다 크면 검증 실패 (모순 차단)', () => {
  assert.throws(() =>
    validateRewardPolicy({
      rewardPerThousandAcceptedImpressions: 300,
      dailyAcceptedImpressionLimit: 500, // 최대 150P/일
      dailyRewardLimit: 1000, // > 150 → 도달 불가능한 상한
      minimumRedemptionPoints: 3000,
      maxReasonableRedemptionDays: 30,
    })
  );
});

test('최소 교환 도달일이 허용일을 넘으면 검증 실패', () => {
  assert.throws(() =>
    validateRewardPolicy({
      rewardPerThousandAcceptedImpressions: 300,
      dailyAcceptedImpressionLimit: 500, // 150P/일
      dailyRewardLimit: 150,
      minimumRedemptionPoints: 100000, // ~667일
      maxReasonableRedemptionDays: 30,
    })
  );
});

test('연속 세션 간격은 최대 연속 시간보다 작아야 한다', () => {
  const p = loadPolicy();
  assert.throws(() =>
    validatePolicy({
      ...p,
      abuse: {
        maxContinuousSessionMs: p.abuse.maxContinuousSessionMs,
        continuousSessionMaxGapMs: p.abuse.maxContinuousSessionMs,
      },
    })
  );
});

test('정책값 변경은 코드 수정 없이 파일(env)로 적용된다', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-policy-'));
  const file = path.join(dir, 'p.json');
  const custom = {
    version: 9,
    reward: {
      rewardPerThousandAcceptedImpressions: 500,
      dailyAcceptedImpressionLimit: 400,
      dailyRewardLimit: 200,
      minimumRedemptionPoints: 2000,
      maxReasonableRedemptionDays: 30,
    },
    survey: { version: 'v1', completionRewardPoints: 500 },
    frequency: { perCampaignDailyImpressionLimit: 20, sameCreativeMinIntervalMs: 600000 },
    impression: { minViewMs: 5000, concurrentToleranceMs: 2000, timeWindowToleranceMs: 60000 },
    statusLine: { refreshIntervalMs: 1000, adRotateMs: 15000, rewardCacheStaleMs: 900000, originalCommandTimeoutMs: 500, clawadCommandTimeoutMs: 1000, healthCheckTimeoutMs: 2000, maxOriginalOutputChars: 160 },
    activity: { staleActiveMs: 120000 },
    abuse: { maxContinuousSessionMs: 86400000, continuousSessionMaxGapMs: 900000 },
    device: { maxDevicesPerAccount: 3 },
    serveToken: { ttlMs: 600000, maxUnusedTokensPerMachine: 3, prefetchRefillThreshold: 1 },
    click: { tokenTtlMs: 600000 },
    advertiser: { defaultCpmKrw: 2000, clickToImpressionMultiplier: 50, vatRate: 0.1 },
  };
  fs.writeFileSync(file, JSON.stringify(custom));
  const p = loadPolicy(file);
  assert.strictEqual(p.version, 9);
  assert.strictEqual(p.reward.rewardPerThousandAcceptedImpressions, 500);
});

// --- 설문 완료 리워드 정책 (CLAW-97) ---

test('설문 리워드 정책값이 기본 정책에 있다', () => {
  const p = loadPolicy();
  assert.ok(typeof p.survey.version === 'string' && p.survey.version.length > 0);
  assert.ok(Number.isInteger(p.survey.completionRewardPoints) && p.survey.completionRewardPoints > 0);
});

test('설문 리워드는 노출 기반 일일 상한과 무관하다', () => {
  const p = loadPolicy();
  // 설문 포인트가 일일 상한을 넘더라도 정책은 유효해야 한다 — 두 축은 서로를 제약하지 않는다.
  validatePolicy({ ...p, survey: { ...p.survey, completionRewardPoints: p.reward.dailyRewardLimit * 100 } });
  // 일일 상한 계산에도 설문 포인트가 섞이지 않는다.
  assert.strictEqual(maxDailyAccrual(p.reward), pointsForImpressions(p.reward, p.reward.dailyAcceptedImpressionLimit));
});

test('설문 정책값이 없거나 잘못되면 거부한다', () => {
  const p = loadPolicy();
  assert.throws(() => validatePolicy({ ...p, survey: undefined }), /survey/);
  assert.throws(() => validateSurveyPolicy({ version: 'v1', completionRewardPoints: 0 }), /completionRewardPoints/);
  assert.throws(() => validateSurveyPolicy({ version: 'v1', completionRewardPoints: 1.5 }), /completionRewardPoints/);
  assert.throws(() => validateSurveyPolicy({ version: '', completionRewardPoints: 500 }), /version/);
});

test('프리페치 재고가 토큰 수명 안에 소비 가능해야 한다 (CLAW-102)', () => {
  const p = loadPolicy();
  // 로테이션 주기 × 보유 토큰 수가 TTL을 넘으면, 뒤쪽 토큰은 표시되기 전에 만료된다.
  const drainMs = p.statusLine.adRotateMs * p.serveToken.maxUnusedTokensPerMachine;
  assert.ok(drainMs <= p.serveToken.ttlMs,
    `보유 토큰 소진에 ${drainMs}ms가 걸리는데 TTL은 ${p.serveToken.ttlMs}ms — 뒤쪽 토큰이 만료된다`);
  // 표시 후 업로드는 sync 주기만큼 늦는다. 업로드 지연 상한이 그보다 넉넉해야 한다.
  assert.ok(p.impression.maxUploadDelayMs > p.serveToken.ttlMs,
    '업로드 지연 상한은 토큰 수명보다 커야 오프라인 보관분이 인정된다');
  assert.ok(p.scheduler.rewardRunIntervalMs > 0, '리워드 적립 주기가 설정돼야 한다');
});
