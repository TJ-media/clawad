'use strict';

const { spawnSync } = require('child_process');
const { npmInvocation } = require('./release');

const PACKAGE_SPEC = '@clawad/cli@latest';
const REGISTRY_TIMEOUT_MS = 5000;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(value) {
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

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < a.core.length; i += 1) {
    if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const compared = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function runNpm(args) {
  try {
    const invocation = npmInvocation(args);
    return spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8', windowsHide: true, timeout: REGISTRY_TIMEOUT_MS,
    });
  } catch (error) {
    return { error };
  }
}

function latestVersion(options = {}) {
  const result = (options.runNpm || runNpm)(['view', PACKAGE_SPEC, 'version', '--json']);
  if (!result || result.error || result.status !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, '')); } catch { return null; }
  if (Array.isArray(parsed)) parsed = parsed.at(-1);
  return parseVersion(parsed) ? parsed : null;
}

function warnIfOutdated(currentVersion, options = {}) {
  const latest = latestVersion(options);
  if (!latest || compareVersions(currentVersion, latest) !== -1) return false;
  const warn = options.warn || console.error;
  const platform = options.platform || process.platform;
  const npx = platform === 'win32' ? 'npx.cmd' : 'npx';
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  warn(`⚠ 현재 실행한 클로애드 CLI v${currentVersion}은 npm 최신 v${latest}보다 오래됐습니다.`);
  warn(`  다시 설치: ${npx} --yes ${PACKAGE_SPEC} setup`);
  warn(`  npx 캐시 초기화: ${npm} cache rm --force _npx`);
  return true;
}

module.exports = { compareVersions, latestVersion, warnIfOutdated };
