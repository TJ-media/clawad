'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scheduler = require('../client/sync-scheduler');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('격리된 데이터 경로에서는 dry-run이 기본값이다 (CLAW-194)', () => {
  const isolated = tempDir('clawad-scheduler-guard-');
  withEnv({ CLAWAD_DATA: isolated, CLAWAD_SCHEDULER_DRY_RUN: undefined, CLAWAD_DISTRIBUTION: undefined }, () => {
    assert.strictEqual(scheduler.context().dryRun, true);
  });
});

test('격리 상태에서도 CLAWAD_SCHEDULER_DRY_RUN=0을 명시하면 실제 조작을 허용한다 (CLAW-194)', () => {
  const isolated = tempDir('clawad-scheduler-guard-');
  withEnv({ CLAWAD_DATA: isolated, CLAWAD_SCHEDULER_DRY_RUN: '0', CLAWAD_DISTRIBUTION: undefined }, () => {
    assert.strictEqual(scheduler.context().dryRun, false);
  });
});

test('CLAWAD_SCHEDULER_DRY_RUN=1은 데이터 경로와 무관하게 dry-run이다', () => {
  withEnv({ CLAWAD_DATA: undefined, CLAWAD_SCHEDULER_DRY_RUN: '1', CLAWAD_DISTRIBUTION: undefined }, () => {
    assert.strictEqual(scheduler.context().dryRun, true);
  });
});

test('기본 데이터 경로에서는 기존처럼 실제 조작이 기본값이다', () => {
  withEnv({ CLAWAD_DATA: undefined, CLAWAD_SCHEDULER_DRY_RUN: undefined, CLAWAD_DISTRIBUTION: undefined }, () => {
    assert.strictEqual(scheduler.context().dryRun, false);
  });
});

test('options.dryRun 명시는 환경 판정보다 우선한다', () => {
  const isolated = tempDir('clawad-scheduler-guard-');
  withEnv({ CLAWAD_DATA: isolated, CLAWAD_SCHEDULER_DRY_RUN: undefined, CLAWAD_DISTRIBUTION: undefined }, () => {
    assert.strictEqual(scheduler.context({ dryRun: false }).dryRun, false);
  });
});
