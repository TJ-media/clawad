'use strict';
// 서버 로직 순수 모듈 유닛 테스트 (CLAW-17/18/6)
const { test } = require('node:test');
const assert = require('node:assert');
const { idempotencyKey } = require('../server/lib/idempotency');
const { issueServeToken, verifyServeToken } = require('../server/lib/serveToken');
const { issueClickToken, verifyClickToken } = require('../server/lib/clickToken');
const concurrent = require('../server/lib/concurrentDedup');
const { decideConcurrent, CONCURRENT_REASON } = concurrent;
const { canRegisterDevice } = require('../server/lib/deviceLimit');
const { eligibility } = require('../server/lib/campaign');

const policyClaims = {
  policySnapshotId: 'snapshot-1',
  policySnapshot: {
    policyVersion: 1,
    rewardPolicyId: 'reward-v1',
    billingEligible: true,
    rewardEligible: true,
    pricePerImpressionKrw: 2,
    rewardPerThousandAcceptedImpressions: 300,
    minViewMs: 5000,
    concurrentToleranceMs: 2000,
    timeWindowToleranceMs: 60000,
    dailyAcceptedImpressionLimit: 500,
    dailyRewardLimit: 150,
    perCampaignDailyImpressionLimit: 20,
    advertiserDailyImpressionLimit: null,
  },
};

// --- 멱등 키 ---
test('멱등 키는 (jti, machineId, sequence)에 결정적이다', () => {
  const a = idempotencyKey('jti-1', 'm-1', 3);
  const b = idempotencyKey('jti-1', 'm-1', 3);
  const c = idempotencyKey('jti-1', 'm-1', 4);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/); // SHA-256 hex
});

// --- clickToken ---
test('클릭 토큰은 HTTPS 목적지만 담고 서명·만료를 검증한다', () => {
  const token = issueClickToken({ campaignId: 'campaign', creativeId: 'creative', userId: 'user', machineId: 'machine', landingUrl: 'https://example.com' }, 'test-secret', 1000, 100);
  const verified = verifyClickToken(token, 'test-secret', 500);
  assert.ok(verified.ok);
  assert.strictEqual(verified.payload.landingUrl, 'https://example.com');
  assert.strictEqual(verifyClickToken(token, 'test-secret', 1101).reason, 'EXPIRED');
  assert.throws(() => issueClickToken({ landingUrl: 'http://example.com' }, 'test-secret', 1000));
});

// --- serveToken ---
test('유효한 serveToken은 검증되고 jti·만료를 담는다', () => {
  const t = issueServeToken(
    { campaignId: 'c-1', creativeId: 'cr-1', userId: 'u-1', machineId: 'm', campaignType: 'PAID', ...policyClaims },
    'secret',
    60000
  );
  const v = verifyServeToken(t, 'secret');
  assert.ok(v.ok);
  assert.ok(v.payload.jti);
  assert.strictEqual(v.payload.userId, 'u-1');
  assert.strictEqual(v.payload.campaignType, 'PAID');
});

test('변조·다른 키 서명 토큰은 거절된다', () => {
  const t = issueServeToken(
    { campaignId: 'c-1', creativeId: 'cr-1', userId: 'u-1', machineId: 'm', campaignType: 'PAID', ...policyClaims },
    'secret',
    60000
  );
  assert.strictEqual(verifyServeToken(t, 'other-secret').ok, false);
  assert.strictEqual(verifyServeToken(t + 'x', 'secret').ok, false);
  assert.strictEqual(verifyServeToken('garbage', 'secret').reason, 'BAD_TOKEN');
});

test('서명된 정책 스냅샷을 바꾸면 토큰이 거절된다', () => {
  const t = issueServeToken(
    { campaignId: 'c-1', creativeId: 'cr-1', userId: 'u-1', machineId: 'm', campaignType: 'PAID', ...policyClaims },
    'secret',
    60000
  );
  const [payloadB64, signature] = t.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  payload.policySnapshot.pricePerImpressionKrw = 999;
  const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
  assert.strictEqual(verifyServeToken(tampered, 'secret').reason, 'BAD_TOKEN');
});

test('만료된 토큰은 EXPIRED로 거절된다', () => {
  const now = Date.now();
  const t = issueServeToken(
    { campaignId: 'c-1', creativeId: 'cr-1', userId: 'u-1', machineId: 'm', campaignType: 'PAID', ...policyClaims },
    'secret',
    1000,
    now
  );
  const v = verifyServeToken(t, 'secret', now + 2000);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'EXPIRED');
});

test('userId가 없는 레거시 serveToken은 거절된다', () => {
  const t = issueServeToken(
    { campaignId: 'c-1', creativeId: 'cr-1', machineId: 'm', campaignType: 'PAID', ...policyClaims },
    'secret',
    60000
  );
  assert.strictEqual(verifyServeToken(t, 'secret').reason, 'BAD_TOKEN');
});

// --- 동시 노출 dedup ---
test('같은 사용자의 겹친 노출은 한 건만 인정한다', () => {
  const accepted = [{ startedAt: 1000, endedAt: 6000, impressionKey: 'a' }];
  const cand = { startedAt: 2000, endedAt: 7000, impressionKey: 'b' }; // 겹침
  const d = decideConcurrent(cand, accepted, 2000);
  assert.strictEqual(d.decision, 'REJECTED');
  assert.strictEqual(d.reason, CONCURRENT_REASON);
  assert.strictEqual(CONCURRENT_REASON, 'CONCURRENT_USER_IMPRESSION');
});

test('겹치지 않는 노출은 각각 인정한다', () => {
  const accepted = [{ startedAt: 1000, endedAt: 6000, impressionKey: 'a' }];
  const cand = { startedAt: 20000, endedAt: 26000, impressionKey: 'b' }; // 허용오차 넘어 분리
  assert.strictEqual(decideConcurrent(cand, accepted, 2000).decision, 'ACCEPTED');
});

test('빈 승인 목록이면 인정한다', () => {
  assert.strictEqual(decideConcurrent({ startedAt: 1, endedAt: 6000 }, [], 2000).decision, 'ACCEPTED');
});

test('동시 노출 재투영은 업로드 순서와 무관하다', () => {
  const rows = [
    { startedAt: 3000, endedAt: 8000, impressionKey: 'later' },
    { startedAt: 0, endedAt: 5000, impressionKey: 'earlier' },
  ];
  assert.deepStrictEqual([...concurrent.projectConcurrent(rows, 0)], ['earlier']);
  assert.deepStrictEqual([...concurrent.projectConcurrent([...rows].reverse(), 0)], ['earlier']);
});

test('연쇄 겹침은 중간 후보를 제외하고 양 끝 후보를 승인한다', () => {
  const rows = [
    { startedAt: 8000, endedAt: 13000, impressionKey: 'c' },
    { startedAt: 4000, endedAt: 9000, impressionKey: 'b' },
    { startedAt: 0, endedAt: 5000, impressionKey: 'a' },
  ];
  assert.deepStrictEqual([...concurrent.projectConcurrent(rows, 0)].sort(), ['a', 'c']);
});

test('동률 시작 시각은 idempotency key 사전순으로 승자를 고른다', () => {
  const rows = [
    { startedAt: 0, endedAt: 5000, impressionKey: 'b-key' },
    { startedAt: 0, endedAt: 5000, impressionKey: 'a-key' },
  ];
  assert.deepStrictEqual([...concurrent.projectConcurrent(rows, 0)], ['a-key']);
});

// --- 기기 제한 ---
test('기기 3대까지 등록, 4대째는 MACHINE_LIMIT_EXCEEDED', () => {
  assert.strictEqual(canRegisterDevice(0, 3).ok, true);
  assert.strictEqual(canRegisterDevice(2, 3).ok, true);
  const gate = canRegisterDevice(3, 3);
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.status, 409);
  assert.strictEqual(gate.code, 'MACHINE_LIMIT_EXCEEDED');
});

// --- 캠페인 유형 ---
test('PAID는 과금·리워드 가능', () => {
  const e = eligibility({ type: 'PAID' });
  assert.deepStrictEqual(e, { billingEligible: true, rewardEligible: true, testOnly: false });
});
test('HOUSE는 기본 미과금·미리워드, 명시 옵트인 시에만 리워드', () => {
  assert.strictEqual(eligibility({ type: 'HOUSE' }).rewardEligible, false);
  assert.strictEqual(eligibility({ type: 'HOUSE' }).billingEligible, false);
  assert.strictEqual(eligibility({ type: 'HOUSE', houseRewardOptIn: true, rewardPolicyId: 'p1' }).rewardEligible, true);
});
test('TEST는 과금·리워드 없음, testOnly', () => {
  assert.deepStrictEqual(eligibility({ type: 'TEST' }), { billingEligible: false, rewardEligible: false, testOnly: true });
});
test('알 수 없는 캠페인 유형은 예외', () => {
  assert.throws(() => eligibility({ type: 'WEIRD' }));
});
