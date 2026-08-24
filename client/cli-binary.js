'use strict';

// 전역 `clawad` 명령(배포 패키지의 bin) 설치·제거 (CLAW-103).
//
// 설치는 **선택 단계**다. 실패해도 클로애드 설치 자체는 계속하고 안내만 기존 npx 형태로 되돌린다
// — 관리형 환경에서 전역 설치가 막혀 있다고 설치 전체를 실패시키지 않는다(CLAW-99의 필수/선택 구분과 같다).
// 가용 여부 판단(읽기)은 핫패스에서도 쓰이므로 distribution-config.js가 담당하고, 여기서는 상태를 쓰기만 한다.

const fs = require('fs');
const { spawnSync } = require('child_process');
const { npmInvocation } = require('./release');
const { cliBinaryAvailable, cliBinaryStateFile, packageSpec } = require('./distribution-config');

const PACKAGE_NAME = '@clawad/cli';
const STATE_VERSION = 1;

// installedVersion을 함께 남긴다 (CLAW-211). 설치 여부만 담으면 전역 명령이 옛 버전에
// 고정된 것을 감지할 근거가 없어, 한 번 어긋나면 `update`로 영영 복구되지 않는다.
function writeState(data, installed, installedVersion = '') {
  try {
    fs.mkdirSync(data, { recursive: true });
    const value = { version: STATE_VERSION, installed, installedVersion, updatedAt: Date.now() };
    fs.writeFileSync(cliBinaryStateFile(data), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

// `@clawad/cli@0.2.0` → `0.2.0`. 스코프의 앞 @에 걸리지 않도록 마지막 @만 본다.
function versionOf(spec) {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(at + 1) : '';
}

function runNpm(args) {
  try {
    const invocation = npmInvocation(args);
    return spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true });
  } catch (error) {
    return { error };
  }
}

function failureReason(result) {
  if (result.error) return result.error.message;
  return (result.stderr || '').trim().split('\n').filter(Boolean).pop() || `npm이 ${result.status} 코드로 종료했습니다.`;
}

// 테스트·CI가 전역 npm 환경을 바꾸지 않도록 하는 가드. 스케줄러의 CLAWAD_SCHEDULER_DRY_RUN과 같은 규약이다.
function dryRun() {
  return process.env.CLAWAD_GLOBAL_CLI_DRY_RUN === '1';
}

// 버전 고정 스펙으로 설치한다(latest를 쓰지 않는다). 레지스트리 스펙이 있으면 그것을 쓴다 —
// tarball URL 설치는 npm allow-remote 설정에 막혀 관리형 PC에서 실패한다 (CLAW-145).
function install(data, spec = packageSpec()) {
  if (!spec || dryRun()) return { installed: false, skipped: true };
  const result = runNpm(['install', '-g', '--no-audit', '--no-fund', spec]);
  if (result.error || result.status !== 0) {
    // 실패 시 기존 상태를 보존한다 (CLAW-260). 직전 버전이 여전히 설치돼 있는데 상태만 지우면
    // update의 repairCliBinary가 가용 여부를 false로 봐 영영 복구하지 않는다 (CLAW-211 재발 경로).
    return { installed: false, skipped: false, reason: failureReason(result) };
  }
  writeState(data, true, versionOf(spec));
  return { installed: true, skipped: false, version: versionOf(spec) };
}

// uninstall 시 원상복구한다(rules §7). 설치한 적이 없으면 전역 환경을 건드리지 않는다.
// 상태는 실제 제거에 성공했을 때만 지운다 (CLAW-260) — 실패에도 미설치로 기록하면
// 다음 uninstall이 조용히 건너뛰어 전역 명령이 영구 잔존한다.
function remove(data) {
  if (!cliBinaryAvailable(data) || dryRun()) return { removed: false, skipped: true };
  const result = runNpm(['uninstall', '-g', PACKAGE_NAME]);
  if (result.error || result.status !== 0) return { removed: false, skipped: false, reason: failureReason(result) };
  writeState(data, false);
  return { removed: true, skipped: false };
}

module.exports = { PACKAGE_NAME, install, remove };
