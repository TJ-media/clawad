'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requestInitialSync } = require('../client/initial-sync');

test('최초 sync 요청은 민감정보 없이 동기화 중 상태를 원자 기록한다', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-initial-sync-'));
  const before = process.env.CLAWAD_INITIAL_SYNC_DRY_RUN;
  process.env.CLAWAD_INITIAL_SYNC_DRY_RUN = '1';
  try {
    const result = requestInitialSync({ data });
    assert.strictEqual(result.dryRun, true);
    const state = JSON.parse(fs.readFileSync(path.join(data, 'preparation-state.json'), 'utf8'));
    assert.strictEqual(state.state, 'SYNCING');
    assert.deepStrictEqual(Object.keys(state).sort(), ['requestedAt', 'state', 'version']);
  } finally {
    if (before === undefined) delete process.env.CLAWAD_INITIAL_SYNC_DRY_RUN;
    else process.env.CLAWAD_INITIAL_SYNC_DRY_RUN = before;
  }
});
