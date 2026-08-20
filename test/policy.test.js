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
  policyDayKey,
  nextPolicyDayStart,
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
    'policyDayShiftMinutes',
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

// 지평이 토큰 수명 이상이면 가용분이 늘 0이라 매 sync마다 리필이 걸려 발급 상한만 소모한다 (CLAW-106).
test('리필 지평은 serveToken 수명보다 작아야 한다', () => {
  const p = loadPolicy();
  assert.ok(p.serveToken.refillHorizonMs > 0, '리필 지평은 기본 정책에 있어야 한다.');
  assert.ok(p.serveToken.refillHorizonMs < p.serveToken.ttlMs);
  assert.throws(() =>
    validatePolicy({
      ...p,
      serveToken: { ...p.serveToken, refillHorizonMs: p.serveToken.ttlMs },
    })
  );
});

// 검증이 없으면 음수·0을 배포해도 부팅은 통과하고 트래픽 경로만 조용히 죽는다 (CLAW-184).
// 클릭 링크는 번들에 실려 캐시에 앉아 있다가 표시 시점에 열린다. 번들보다 먼저 만료되면
// 광고는 정상 표시·적립되는데 클릭만 전부 CLICK_LINK_EXPIRED가 된다 (CLAW-229).
test('클릭 토큰 수명은 serveToken 수명보다 짧을 수 없다', () => {
  const p = loadPolicy();
  assert.ok(p.click.tokenTtlMs >= p.serveToken.ttlMs,
    `클릭 토큰 ${p.click.tokenTtlMs}ms가 번들 ${p.serveToken.ttlMs}ms보다 짧으면 캐시된 광고의 클릭이 죽는다`);
  assert.throws(() => validatePolicy({
    ...p,
    click: { ...p.click, tokenTtlMs: p.serveToken.ttlMs - 1 },
  }), /click\.tokenTtlMs/);
});

// 포상 금액은 운영자가 건별로 정한다. 정책은 상한만 강제한다 — 상한이 없으면 오타 한 번이
// 그대로 원장에 들어가고, 원장은 수정·삭제할 수 없다 (CLAW-234, rules §4·§5).
test('제보 정책값이 부팅에서 검증된다 (CLAW-234)', () => {
  const p = loadPolicy();
  for (const key of ['maxRewardPoints', 'dailySubmitLimit', 'maxBodyLength']) {
    assert.ok(Number.isInteger(p.bugReport[key]) && p.bugReport[key] > 0, `bugReport.${key}는 양의 정수여야 한다`);
    for (const bad of [0, -1, 1.5, null, undefined, '100']) {
      assert.throws(() => validatePolicy({ ...p, bugReport: { ...p.bugReport, [key]: bad } }));
    }
  }
  // 기본값 폴백 금지 — 섹션이 통째로 빠지면 부팅에서 막는다.
  const withoutSection = { ...p };
  delete withoutSection.bugReport;
  assert.throws(() => validatePolicy(withoutSection));
});

test('광고 신청 입금액 범위 불변식을 부팅에서 검증한다 (CLAW-249)', () => {
  const p = loadPolicy();
  const advertiser = (over) => ({ ...p, advertiser: { ...p.advertiser, ...over } });

  // 하한이 상한을 넘으면 어떤 금액도 통과하지 못하는 폼이 배포된다.
  assert.throws(() => validatePolicy(advertiser({ minDepositKrw: 20000, maxDepositKrw: 10000 })), /minDepositKrw/);
  // 하한이 노출 1건 단가보다 낮으면 한 번도 못 띄우는 신청이 접수된다.
  assert.throws(() => validatePolicy(advertiser({ defaultCpmKrw: 2000, minDepositKrw: 1 })), /minDepositKrw/);
  // 경계는 통과한다 — 딱 1회 노출되는 금액.
  assert.doesNotThrow(() => validatePolicy(advertiser({ defaultCpmKrw: 2000, minDepositKrw: 2, maxDepositKrw: 2 })));
});

test('빈도·광고주·프리페치·스케줄러 정책값이 부팅에서 검증된다 (CLAW-184)', () => {
  const p = loadPolicy();
  const cases = [
    ['frequency', 'perCampaignDailyImpressionLimit'],
    ['frequency', 'sameCreativeMinIntervalMs'],
    ['advertiser', 'defaultCpmKrw'],
    ['advertiser', 'clickToImpressionMultiplier'],
    ['advertiser', 'minDepositKrw'],
    ['advertiser', 'maxDepositKrw'],
    ['serveToken', 'prefetchRefillThreshold'],
    ['scheduler', 'rewardRunIntervalMs'],
  ];
  for (const [section, key] of cases) {
    assert.ok(Number.isInteger(p[section][key]) && p[section][key] > 0, `${section}.${key}는 기본 정책에 있어야 한다.`);
    for (const bad of [0, -1, 1.5, null, '10']) {
      assert.throws(
        () => validatePolicy({ ...p, [section]: { ...p[section], [key]: bad } }),
        new RegExp(`${section}\\.${key}`),
        `${section}.${key}=${bad}이(가) 통과했다`
      );
    }
  }
});

// vatRate는 비율(0.1)이라 양의 정수 검증을 그대로 걸면 현행 정책이 부팅에서 거부된다 (CLAW-184).
test('advertiser.vatRate는 정수가 아니라 0 이상 1 미만 비율로 검증한다 (CLAW-184)', () => {
  const p = loadPolicy();
  assert.ok(p.advertiser.vatRate >= 0 && p.advertiser.vatRate < 1);
  assert.doesNotThrow(() => validatePolicy({ ...p, advertiser: { ...p.advertiser, vatRate: 0 } }));
  assert.doesNotThrow(() => validatePolicy({ ...p, advertiser: { ...p.advertiser, vatRate: 0.25 } }));
  for (const bad of [-0.1, 1, 1.5, null, '0.1']) {
    assert.throws(() => validatePolicy({ ...p, advertiser: { ...p.advertiser, vatRate: bad } }), /vatRate/);
  }
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
      policyDayShiftMinutes: 180,
    },
    survey: { version: 'v1', completionRewardPoints: 500 },
    frequency: { perCampaignDailyImpressionLimit: 20, sameCreativeMinIntervalMs: 600000 },
    impression: { minViewMs: 5000, concurrentToleranceMs: 2000, timeWindowToleranceMs: 60000, maxUploadDelayMs: 86400000 },
    client: { hookHealthCheckTimeoutMs: 2000 },
    overlay: { adRotateMs: 15000, adGapMs: 3000, idleThresholdMs: 60000, maxWidthPx: 360, eventSpoolMaxFiles: 200, eventSpoolRetentionMs: 86400000 },
    activity: { staleActiveMs: 120000, workStateRetentionMs: 604800000 },
    abuse: { maxContinuousSessionMs: 86400000, continuousSessionMaxGapMs: 900000 },
    device: { maxDevicesPerAccount: 3 },
    serveToken: { ttlMs: 600000, maxUnusedTokensPerMachine: 3, prefetchRefillThreshold: 1, refillHorizonMs: 60000 },
    click: { tokenTtlMs: 600000 },
    bugReport: { maxRewardPoints: 3000, dailySubmitLimit: 5, maxBodyLength: 2000 },
    advertiser: { defaultCpmKrw: 2000, minDepositKrw: 10000, maxDepositKrw: 10000000, clickToImpressionMultiplier: 50, vatRate: 0.1 },
    // reward-scheduler.service가 폴백 없이 읽는 값이라 정책에 반드시 있어야 한다 (CLAW-184).
    scheduler: { rewardRunIntervalMs: 60000 },
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

// --- 오버레이 서피스 정책 (CLAW-86) ---

test('오버레이 정책값이 기본 정책에 있다', () => {
  const p = loadPolicy();
  assert.ok(Number.isInteger(p.overlay.adRotateMs) && p.overlay.adRotateMs > 0);
  assert.ok(Number.isInteger(p.overlay.idleThresholdMs) && p.overlay.idleThresholdMs > 0);
  assert.ok(Number.isInteger(p.overlay.maxWidthPx) && p.overlay.maxWidthPx > 0);
});

test('overlay 섹션 누락 시 검증이 실패한다 — 기본값 폴백 금지', () => {
  const p = loadPolicy();
  assert.throws(() => validatePolicy({ ...p, overlay: undefined }), /overlay/);
  assert.throws(() => validatePolicy({ ...p, overlay: null }), /overlay/);
});

test('overlay 불변식: 광고 교체·유휴 판정 주기는 최소 노출 시간보다 짧을 수 없다', () => {
  const p = loadPolicy();
  assert.throws(
    () => validatePolicy({ ...p, overlay: { ...p.overlay, adRotateMs: p.impression.minViewMs - 1 } }),
    /overlay\.adRotateMs/
  );
  assert.throws(
    () => validatePolicy({ ...p, overlay: { ...p.overlay, idleThresholdMs: p.impression.minViewMs - 1 } }),
    /overlay\.idleThresholdMs/
  );
});

// 서버는 동시 노출 판정 구간을 concurrentToleranceMs만큼 양쪽으로 넓힌다. 인정 구간 사이
// 간격이 그 이하면 연속 노출이 서로 CONCURRENT_USER_IMPRESSION으로 걸린다 (CLAW-135).
test('overlay 불변식: 인정 구간 간격은 동시 노출 허용 오차보다 커야 한다 (CLAW-135)', () => {
  const p = loadPolicy();
  assert.ok(p.overlay.adGapMs > p.impression.concurrentToleranceMs, '기본 정책이 불변식을 만족해야 한다');
  assert.throws(
    () => validatePolicy({ ...p, overlay: { ...p.overlay, adGapMs: p.impression.concurrentToleranceMs } }),
    /overlay\.adGapMs/
  );
  assert.throws(
    () => validatePolicy({ ...p, overlay: { ...p.overlay, adGapMs: 0 } }),
    /overlay\.adGapMs/
  );
});

test('overlay 불변식: 간격을 뺀 인정 구간이 최소 노출 시간 이상이어야 한다 (CLAW-135)', () => {
  const p = loadPolicy();
  assert.ok(p.overlay.adRotateMs - p.overlay.adGapMs >= p.impression.minViewMs);
  assert.throws(
    () => validatePolicy({ ...p, overlay: { ...p.overlay, adGapMs: p.overlay.adRotateMs - p.impression.minViewMs + 1 } }),
    /overlay\.adRotateMs - overlay\.adGapMs/
  );
});

// --- 오버레이 이벤트 스풀 위생 정책 (CLAW-90) ---

// 활동 기록은 단순 로그가 아니라 인정 노출 판정의 입력이다. 미수거 스풀이 참조할 구간을
// 먼저 지우면 인정될 노출이 BELOW_MIN_VIEW로 조용히 사라진다 (CLAW-143).
test('활동 기록 보유기간 불변식: 스풀 보존기간 이상, 활성 판정 기준 이상', () => {
  const p = loadPolicy();
  assert.ok(Number.isInteger(p.activity.workStateRetentionMs) && p.activity.workStateRetentionMs > 0);
  assert.ok(p.activity.workStateRetentionMs >= p.overlay.eventSpoolRetentionMs, '기본 정책이 불변식을 만족해야 한다');

  assert.throws(
    () => validatePolicy({ ...p, activity: { ...p.activity, workStateRetentionMs: p.overlay.eventSpoolRetentionMs - 1 } }),
    /activity\.workStateRetentionMs/,
  );
  assert.throws(
    () => validatePolicy({ ...p, activity: { ...p.activity, workStateRetentionMs: p.activity.staleActiveMs - 1 } }),
    /activity\.workStateRetentionMs/,
  );
  assert.throws(
    () => validatePolicy({ ...p, activity: { ...p.activity, workStateRetentionMs: 0 } }),
    /activity\.workStateRetentionMs/,
  );
});

test('스풀 위생 정책값이 기본 정책에 있다', () => {
  const p = loadPolicy();
  assert.ok(Number.isInteger(p.overlay.eventSpoolMaxFiles) && p.overlay.eventSpoolMaxFiles > 0);
  assert.ok(Number.isInteger(p.overlay.eventSpoolRetentionMs) && p.overlay.eventSpoolRetentionMs > 0);
});

test('스풀 보존기간 불변식: 광고 교체 주기 이상, 업로드 지연 상한 이하', () => {
  const p = loadPolicy();
  assert.throws(
    () => validatePolicy({ ...p, overlay: { ...p.overlay, eventSpoolRetentionMs: p.overlay.adRotateMs - 1 } }),
    /overlay\.eventSpoolRetentionMs/
  );
  assert.throws(
    () => validatePolicy({ ...p, overlay: { ...p.overlay, eventSpoolRetentionMs: p.impression.maxUploadDelayMs + 1 } }),
    /overlay\.eventSpoolRetentionMs/
  );
  assert.throws(
    () => validatePolicy({ ...p, overlay: { ...p.overlay, eventSpoolMaxFiles: 0 } }),
    /overlay\.eventSpoolMaxFiles/
  );
});

test('프리페치 재고가 토큰 수명 안에 소비 가능해야 한다 (CLAW-102)', () => {
  const p = loadPolicy();
  // 로테이션 주기 × 보유 토큰 수가 TTL을 넘으면, 뒤쪽 토큰은 표시되기 전에 만료된다.
  const drainMs = p.overlay.adRotateMs * p.serveToken.maxUnusedTokensPerMachine;
  assert.ok(drainMs <= p.serveToken.ttlMs,
    `보유 토큰 소진에 ${drainMs}ms가 걸리는데 TTL은 ${p.serveToken.ttlMs}ms — 뒤쪽 토큰이 만료된다`);
  // 표시 후 업로드는 sync 주기만큼 늦는다. 업로드 지연 상한이 그보다 넉넉해야 한다.
  assert.ok(p.impression.maxUploadDelayMs > p.serveToken.ttlMs,
    '업로드 지연 상한은 토큰 수명보다 커야 오프라인 보관분이 인정된다');
  assert.ok(p.scheduler.rewardRunIntervalMs > 0, '리워드 적립 주기가 설정돼야 한다');
});

// --- 정책일 경계 (CLAW-151) ---

// 이 이슈의 실제 버그: 경계가 UTC 자정이라 한국 사용자의 한밤중(09:00 KST가 아니라 자정 무렵)에
// 하루가 갈렸고, 1P가 되지 못한 캐리가 그 지점에서 버려졌다. 경계를 KST 06:00으로 옮기면
// UTC 자정을 사이에 둔 두 시각이 **같은 정책일**이어야 한다.
test('정책일은 UTC 자정에 갈리지 않는다 — 캐리가 버려지던 지점 (CLAW-151)', () => {
  const shift = loadPolicy().reward.policyDayShiftMinutes;
  const before = policyDayKey(new Date('2026-08-03T23:59:00Z'), shift);
  const after = policyDayKey(new Date('2026-08-04T00:01:00Z'), shift);
  assert.strictEqual(before, after, 'UTC 자정을 넘어도 같은 정책일이어야 한다');
});

test('정책일 경계는 한국시간 06:00이고 라벨은 그 구간의 한국 날짜다 (CLAW-151)', () => {
  const shift = loadPolicy().reward.policyDayShiftMinutes;
  // UTC 21:00 = KST 익일 06:00. 그 직전과 직후가 갈려야 한다.
  assert.strictEqual(policyDayKey(new Date('2026-08-03T20:59:59Z'), shift), '2026-08-03');
  assert.strictEqual(policyDayKey(new Date('2026-08-03T21:00:00Z'), shift), '2026-08-04');
  // 구간 [KST 8/4 06:00, KST 8/5 06:00)의 라벨은 한국 날짜 8/4다.
  assert.strictEqual(policyDayKey(new Date('2026-08-04T12:00:00Z'), shift), '2026-08-04');
  assert.strictEqual(policyDayKey(new Date('2026-08-04T20:59:59Z'), shift), '2026-08-04');
});

test('shift 0은 UTC 자정 경계 — 값 도입 이전 동작 (CLAW-151)', () => {
  assert.strictEqual(policyDayKey(new Date('2026-08-03T23:59:00Z'), 0), '2026-08-03');
  assert.strictEqual(policyDayKey(new Date('2026-08-04T00:01:00Z'), 0), '2026-08-04');
});

// 클라이언트는 이 값으로 "언제 다시 받을 수 있는지"를 안내한다 (CLAW-150 dailyCapResetsAt).
test('다음 정책일 경계는 항상 미래이고 24시간 이내다 (CLAW-151)', () => {
  const shift = loadPolicy().reward.policyDayShiftMinutes;
  assert.strictEqual(
    nextPolicyDayStart(new Date('2026-08-03T22:00:00Z'), shift).toISOString(),
    '2026-08-04T21:00:00.000Z'
  );
  // 경계 직후에 서면 꼬박 하루 뒤가 다음 경계다.
  assert.strictEqual(
    nextPolicyDayStart(new Date('2026-08-03T21:00:00Z'), shift).toISOString(),
    '2026-08-04T21:00:00.000Z'
  );
  // 월말 롤오버에서도 날짜 계산이 깨지지 않는다.
  assert.strictEqual(
    nextPolicyDayStart(new Date('2026-08-31T23:00:00Z'), shift).toISOString(),
    '2026-09-01T21:00:00.000Z'
  );
  for (const iso of ['2026-01-01T00:00:00Z', '2026-08-03T20:59:59Z', '2026-12-31T21:00:00Z']) {
    const at = new Date(iso);
    const next = nextPolicyDayStart(at, shift);
    assert.ok(next > at, `${iso}: 다음 경계는 미래여야 한다`);
    assert.ok(next - at <= 86400000, `${iso}: 다음 경계는 24시간 이내여야 한다`);
    // 경계는 정확히 정책일이 바뀌는 지점이다.
    assert.notStrictEqual(policyDayKey(next, shift), policyDayKey(new Date(next - 1), shift));
  }
});

test('정책일 경계값 검증: 0은 허용, 하루 이상과 정수 아닌 값은 거부 (CLAW-151)', () => {
  const p = loadPolicy();
  const withShift = (policyDayShiftMinutes) =>
    validatePolicy({ ...p, reward: { ...p.reward, policyDayShiftMinutes } });
  assert.doesNotThrow(() => withShift(0), '0(UTC 자정 경계)은 유효한 값이다');
  assert.doesNotThrow(() => withShift(1439));
  assert.throws(() => withShift(1440), /policyDayShiftMinutes/);
  assert.throws(() => withShift(-1), /policyDayShiftMinutes/);
  assert.throws(() => withShift(1.5), /policyDayShiftMinutes/);
  assert.throws(() => withShift(undefined), /policyDayShiftMinutes/);
});

// 정책 스키마에 필수 섹션을 추가할 때 기본 정책만 고치고 테스트 픽스처를 빼먹으면,
// 루트 테스트는 통과하지만 픽스처를 쓰는 API e2e가 500으로 죽는다(CLAW-86에서 실제 발생).
// 저장소의 모든 정책 파일을 같은 검증기에 통과시켜 그 누락을 여기서 잡는다.
test('저장소의 모든 정책 파일이 불변식을 통과한다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const dirs = [path.join(root, 'policy'), path.join(root, 'apps', 'api', 'test', 'fixtures')];
  const files = dirs
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json') && name.includes('policy'))
      .map((name) => path.join(dir, name)));

  assert.ok(files.length >= 3, `정책 파일을 찾지 못했다 (발견 ${files.length}개)`);
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    assert.doesNotThrow(() => validatePolicy(parsed), `${path.relative(root, file)}가 정책 불변식을 위반한다`);
  }
});
