'use strict';
// 전역 clawad 명령 상태 기록 (CLAW-260). 상태 파일은 실제 전역 환경과 일치해야 한다 —
// npm이 실패했는데 미설치로 기록하면 다음 uninstall이 건너뛰어 전역 명령이 영구 잔존하고(rules §7),
// install 실패가 기존 상태를 지우면 update의 repairCliBinary가 영영 발동하지 않는다 (CLAW-211).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cliBinary = require('../client/cli-binary');
const { cliBinaryAvailable, cliBinaryVersion } = require('../client/distribution-config');

// 실제 npm·전역 이름공간을 건드리지 않도록 항상 실패하는 가짜 npm을 주입한다.
// win32는 npm_execpath(npm-cli.js)를, 그 외는 PATH의 npm을 쓴다 (client/release.js npmInvocation).
function withFailingNpm(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-fake-npm-'));
  const fakeCli = path.join(dir, 'npm-cli.js');
  fs.writeFileSync(fakeCli, 'process.stderr.write("npm ERR! fake failure\\n"); process.exit(1);\n');
  fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\necho "npm ERR! fake failure" >&2\nexit 1\n', { mode: 0o755 });
  const saved = { npm_execpath: process.env.npm_execpath, PATH: process.env.PATH, CLAWAD_GLOBAL_CLI_DRY_RUN: process.env.CLAWAD_GLOBAL_CLI_DRY_RUN };
  process.env.npm_execpath = fakeCli;
  process.env.PATH = dir;
  delete process.env.CLAWAD_GLOBAL_CLI_DRY_RUN;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function installedState(data, installedVersion) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'cli-binary.json'),
    JSON.stringify({ version: 1, installed: true, installedVersion, updatedAt: Date.now() }));
}

test('전역 명령 제거 실패는 상태를 미설치로 기록하지 않는다 (CLAW-260)', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-cli-state-'));
  installedState(data, '0.2.0');

  const result = withFailingNpm(() => cliBinary.remove(data));

  assert.strictEqual(result.removed, false);
  assert.strictEqual(result.skipped, false);
  assert.ok(result.reason, '실패 사유를 보고해야 한다');
  assert.strictEqual(cliBinaryAvailable(data), true, '제거 실패면 전역 명령이 그대로 있다 — 재시도가 건너뛰면 안 된다');
});

test('전역 명령 설치 실패는 기존 상태를 지우지 않는다 (CLAW-260)', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-cli-state-'));
  installedState(data, '0.2.0');

  const result = withFailingNpm(() => cliBinary.install(data, '@clawad/cli@9.9.9'));

  assert.strictEqual(result.installed, false);
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(cliBinaryAvailable(data), true, '직전 버전이 여전히 설치돼 있다');
  assert.strictEqual(cliBinaryVersion(data), '0.2.0', 'repairCliBinary가 뒤처짐을 감지할 근거를 지우면 안 된다');
});
