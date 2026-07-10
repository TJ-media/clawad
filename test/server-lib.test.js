'use strict';
// 서버 로직 순수 모듈 유닛 테스트 (CLAW-17/18/6)
const { test } = require('node:test');
const assert = require('node:assert');
const { idempotencyKey } = require('../server/lib/idempotency');
const { issueServeToken, verifyServeToken } = require('../server/lib/serveToken');
const { decideConcurrent, CONCURRENT_REASON } = require('../server/lib/concurrentDedup');
const { canRegisterDevice } = require('../server/lib/deviceLimit');
const { eligibility } = require('../server/lib/campaign');

// --- 멱등 키 ---
test('멱등 키는 (jti, machineId, sequence)에 결정적이다', () => {
  const a = idempotencyKey('jti-1', 'm-1', 3);
  const b = idempotencyKey('jti-1', 'm-1', 3);
  const c = idempotencyKey('jti-1', 'm-1', 4);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/); // SHA-256 hex
});

// --- serveToken ---
test('유효한 serveToken은 검증되고 jti·만료를 담는다', () => {
  const t = issueServeToken({ campaignId: 1, creativeId: 2, machineId: 'm', campaignType: 'PAID' }, 'secret', 60000);
  const v = verifyServeToken(t, 'secret');
  assert.ok(v.ok);
  assert.ok(v.payload.jti);
  assert.strictEqual(v.payload.campaignType, 'PAID');
});

test('변조·다른 키 서명 토큰은 거절된다', () => {
  const t = issueServeToken({ campaignId: 1, machineId: 'm', campaignType: 'PAID' }, 'secret', 60000);
  assert.strictEqual(verifyServeToken(t, 'other-secret').ok, false);
  assert.strictEqual(verifyServeToken(t + 'x', 'secret').ok, false);
  assert.strictEqual(verifyServeToken('garbage', 'secret').reason, 'BAD_TOKEN');
});

test('만료된 토큰은 EXPIRED로 거절된다', () => {
  const now = Date.now();
  const t = issueServeToken({ campaignId: 1, machineId: 'm', campaignType: 'PAID' }, 'secret', 1000, now);
  const v = verifyServeToken(t, 'secret', now + 2000);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'EXPIRED');
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
