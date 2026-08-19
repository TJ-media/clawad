'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const MODULE = path.join(__dirname, '..', 'client', 'registry-version.js');

test('설치 버전이 npm latest보다 낮으면 복구 명령을 경고한다 (CLAW-237)', () => {
  assert.strictEqual(fs.existsSync(MODULE), true, '레지스트리 버전 확인 모듈이 필요하다');
  const { warnIfOutdated } = require(MODULE);
  const warnings = [];

  const outdated = warnIfOutdated('0.2.3', {
    runNpm: () => ({ status: 0, stdout: '"0.2.5"\n', stderr: '' }),
    warn: (line) => warnings.push(line),
    platform: 'win32',
  });

  assert.strictEqual(outdated, true);
  assert.ok(warnings.some((line) => /0\.2\.3/.test(line) && /0\.2\.5/.test(line)));
  assert.ok(warnings.some((line) => /npx\.cmd --yes @clawad\/cli@latest setup/.test(line)));
});

test('레지스트리 조회 실패는 설치를 막거나 경고를 만들지 않는다 (CLAW-237)', () => {
  assert.strictEqual(fs.existsSync(MODULE), true, '레지스트리 버전 확인 모듈이 필요하다');
  const { warnIfOutdated } = require(MODULE);
  const warnings = [];

  const outdated = warnIfOutdated('0.2.3', {
    runNpm: () => ({ status: 1, stdout: '', stderr: 'offline' }),
    warn: (line) => warnings.push(line),
  });

  assert.strictEqual(outdated, false);
  assert.deepStrictEqual(warnings, []);
});

test('같거나 더 최신인 설치 버전은 경고하지 않는다 (CLAW-237)', () => {
  assert.strictEqual(fs.existsSync(MODULE), true, '레지스트리 버전 확인 모듈이 필요하다');
  const { warnIfOutdated } = require(MODULE);
  for (const [current, latest] of [['0.2.5', '0.2.5'], ['0.3.0', '0.2.5']]) {
    const warnings = [];
    const outdated = warnIfOutdated(current, {
      runNpm: () => ({ status: 0, stdout: JSON.stringify(latest), stderr: '' }),
      warn: (line) => warnings.push(line),
    });
    assert.strictEqual(outdated, false, `${current} 대 ${latest}`);
    assert.deepStrictEqual(warnings, [], `${current} 대 ${latest}`);
  }
});
