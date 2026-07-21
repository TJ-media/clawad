'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { appendEventSummary, emptySummary, readSummary, rebuildSummary } = require('../client/ledger-summary');

function tempData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-summary-'));
}

test('원장에서 요약을 재구축하면 누적·오늘·sequence가 일치한다', () => {
  const data = tempData();
  const ledger = path.join(data, 'ledger.jsonl');
  const summary = path.join(data, 'ledger-summary.json');
  const now = Date.now();
  fs.writeFileSync(ledger, [
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
