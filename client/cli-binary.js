'use strict';

// 전역 `clawad` 명령(배포 패키지의 bin) 설치·제거 (CLAW-103).
//
// 설치는 **선택 단계**다. 실패해도 클로애드 설치 자체는 계속하고 안내만 기존 npx 형태로 되돌린다
// — 관리형 환경에서 전역 설치가 막혀 있다고 설치 전체를 실패시키지 않는다(CLAW-99의 필수/선택 구분과 같다).
// 가용 여부 판단(읽기)은 핫패스에서도 쓰이므로 distribution-config.js가 담당하고, 여기서는 상태를 쓰기만 한다.

const fs = require('fs');
const { spawnSync } = require('child_process');
const { npmInvocation } = require('./release');
const { cliBinaryAvailable, cliBinaryStateFile, distributionConfig } = require('./distribution-config');

const PACKAGE_NAME = '@clawad/cli';
const STATE_VERSION = 1;

function writeState(data, installed) {
  try {
    fs.mkdirSync(data, { recursive: true });
    const value = { version: STATE_VERSION, installed, updatedAt: Date.now() };
    fs.writeFileSync(cliBinaryStateFile(data), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  } catch {}
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

// 버전 고정 packageUrl로 설치해 무결성 계약을 유지한다(latest URL을 쓰지 않는다).
function install(data, packageUrl = distributionConfig().packageUrl) {
  if (!packageUrl || dryRun()) return { installed: false, skipped: true };
  const result = runNpm(['install', '-g', '--no-audit', '--no-fund', packageUrl]);
  if (result.error || result.status !== 0) {
    writeState(data, false);
    return { installed: false, skipped: false, reason: failureReason(result) };
  }
  writeState(data, true);
  return { installed: true, skipped: false };
}

// uninstall 시 원상복구한다(rules §7). 설치한 적이 없으면 전역 환경을 건드리지 않는다.
function remove(data) {
  if (!cliBinaryAvailable(data) || dryRun()) return { removed: false, skipped: true };
  const result = runNpm(['uninstall', '-g', PACKAGE_NAME]);
  writeState(data, false);
  if (result.error || result.status !== 0) return { removed: false, skipped: false, reason: failureReason(result) };
  return { removed: true, skipped: false };
}

module.exports = { PACKAGE_NAME, install, remove };
