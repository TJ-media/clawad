#!/usr/bin/env node
'use strict';
// `npx clawad ...`로 들어온 호출을 실제 패키지 @clawad/cli로 넘긴다.
//
// cli.js는 require.main 가드가 없고 process.argv[2]부터 읽는다. 이 파일이 argv[1]이므로
// 인자 위치가 그대로 맞아, 두 번째 node 프로세스를 띄우지 않고 require 한 번으로 끝난다.
// 경로를 직접 적지 않고 의존 패키지의 bin 선언을 따라간다 — 내부 배치가 바뀌어도 깨지지 않는다.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const REGISTRY_TIMEOUT_MS = 5000;

function parsedVersion(value) {
  const match = VERSION_PATTERN.exec(value || '');
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left === right ? 0 : (left < right ? -1 : 1);
}

function isOlderVersion(current, latest) {
  const left = parsedVersion(current);
  const right = parsedVersion(latest);
  if (!left || !right) return false;
  for (let i = 0; i < left.core.length; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length > 0 && right.prerelease.length === 0;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (left.prerelease[i] === undefined) return true;
    if (right.prerelease[i] === undefined) return false;
    const compared = compareIdentifiers(left.prerelease[i], right.prerelease[i]);
    if (compared !== 0) return compared < 0;
  }
  return false;
}

function npmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'npm', args };
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && path.basename(npmExecPath) === 'npm-cli.js') {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(bundled)) return null;
  return { command: process.execPath, args: [bundled, ...args] };
}

function warnIfOutdated(currentVersion) {
  try {
    const args = ['view', '@clawad/cli@latest', 'version', '--json'];
    const invocation = npmInvocation(args);
    if (!invocation) return;
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8', windowsHide: true, timeout: REGISTRY_TIMEOUT_MS,
    });
    if (!result || result.error || result.status !== 0) return;
    const latest = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, ''));
    if (!isOlderVersion(currentVersion, latest)) return;
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    console.error(`⚠ npx 캐시가 구버전 @clawad/cli v${currentVersion}을 불러왔습니다. npm 최신 버전은 v${latest}입니다.`);
    console.error(`  최신 버전 실행: ${npx} --yes @clawad/cli@latest ${process.argv[2]}`);
  } catch { /* 레지스트리 조회 실패는 별칭 실행을 막지 않는다. */ }
}

let target;
try {
  const pkg = require('@clawad/cli/package.json');
  if (process.argv[2] === 'setup' || process.argv[2] === 'update') warnIfOutdated(pkg.version);
  const bin = pkg.bin && (typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.clawad);
  if (!bin) throw new Error('@clawad/cli에 clawad bin 선언이 없습니다.');
  target = require.resolve('@clawad/cli/' + bin.replace(/^\.\//, ''));
} catch (error) {
  console.error('클로애드 CLI(@clawad/cli)를 찾을 수 없습니다. 이 패키지는 이름 별칭일 뿐입니다.');
  console.error('직접 실행: npx --yes @clawad/cli setup');
  console.error(`사유: ${error && error.message ? error.message : error}`);
  process.exit(1);
}

require(target);
