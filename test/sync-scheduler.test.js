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

// linux 경로는 스케줄러 등록이 파일(systemd 유닛)이라, 실 OS 스케줄러를 건드리지 않고
// 설치 실패~롤백 흐름을 어느 플랫폼에서든 재현할 수 있다. systemctl 호출은 이 환경에서
// 반드시 실패하므로(부재 또는 임시 홈의 유닛 미인식) install이 던지는 지점이 된다.
function linuxInstallOptions(home, data) {
  return { platform: 'linux', home, data, dryRun: false, server: 'http://localhost:3000' };
}

test('설치 실패 시 기존 등록이 있으면 롤백이 그것을 보존한다 (CLAW-196)', () => {
  const home = tempDir('clawad-scheduler-home-');
  const data = tempDir('clawad-scheduler-data-');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const timer = path.join(unitDir, 'clawad-sync.timer');
  fs.writeFileSync(timer, '[Timer]\n');

  assert.throws(() => scheduler.install(linuxInstallOptions(home, data)));
  assert.strictEqual(fs.existsSync(timer), true, '기존 예약 등록이 롤백에서 삭제되면 안 된다');
});

test('설치 실패 시 기존 등록이 없으면 부분 설치 잔재를 정리한다 (CLAW-196)', () => {
  const home = tempDir('clawad-scheduler-home-');
  const data = tempDir('clawad-scheduler-data-');
  const timer = path.join(home, '.config', 'systemd', 'user', 'clawad-sync.timer');

  assert.throws(() => scheduler.install(linuxInstallOptions(home, data)));
  assert.strictEqual(fs.existsSync(timer), false, '이번 설치가 만든 유닛 파일은 롤백이 지워야 한다');
});
