'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { appendEventSummary, dayKey, emptySummary, readSummary, rebuildSummary } = require('../client/ledger-summary');

// "오늘 업로드 결과" 진단이 서버가 말하는 "오늘"과 같은 하루를 세야 한다 (CLAW-271, CLAW-151).
test('일자 키는 서버 정책일 경계(KST 06:00)를 따른다 (CLAW-271)', () => {
  // UTC 8/23 22:00 = KST 8/24 07:00 → 정책일 2026-08-24. UTC 자정 기준이면 2026-08-23으로 어긋난다.
  assert.strictEqual(dayKey(Date.UTC(2026, 7, 23, 22, 0, 0)), '2026-08-24');
  // UTC 8/23 02:00 = KST 8/23 11:00 → 정책일 2026-08-23.
  assert.strictEqual(dayKey(Date.UTC(2026, 7, 23, 2, 0, 0)), '2026-08-23');
});

function tempData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-summary-'));
}

test('원장에서 요약을 재구축하면 누적·오늘·sequence가 일치한다', () => {
  const data = tempData();
  const ledger = path.join(data, 'ledger.jsonl');
  const summary = path.join(data, 'ledger-summary.json');
  const now = Date.now();
  // BOM이 붙은 파일도 첫 줄이 삼켜지지 않아야 한다 (CLAW-269, rules §8).
  fs.writeFileSync(ledger, '﻿' + [
    JSON.stringify({ sequence: 2, startedAt: now }),
    JSON.stringify({ sequence: 8, startedAt: now - 24 * 60 * 60 * 1000 }),
    '{broken',
  ].join('\n') + '\n');
  const rebuilt = rebuildSummary(ledger, summary, now);
  assert.strictEqual(rebuilt.totalImpressions, 2);
  assert.strictEqual(rebuilt.todayImpressions, 1);
  assert.strictEqual(rebuilt.nextSequence, 8);
  assert.deepStrictEqual(readSummary(summary), rebuilt);
});

test('append 요약은 원장을 다시 읽지 않고 O(1) 값만 갱신한다', () => {
  const now = Date.now();
  const result = appendEventSummary(emptySummary(now), { sequence: 1, startedAt: now }, now);
  assert.strictEqual(result.totalImpressions, 1);
  assert.strictEqual(result.todayImpressions, 1);
  assert.strictEqual(result.nextSequence, 1);
});
