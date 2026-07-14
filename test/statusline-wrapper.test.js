'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRAPPER = path.join(__dirname, '..', 'client', 'statusline-wrapper.js');

function fixture(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-wrapper-'));
  const original = path.join(dir, 'original.js');
  fs.writeFileSync(original, source);
  fs.writeFileSync(path.join(dir, 'statusline-composition.json'), JSON.stringify({
    version: 1, originalCommand: `"${process.execPath}" "${original}"`,
  }));
  return dir;
}

function run(data, paused = true) {
  if (paused) fs.writeFileSync(path.join(data, 'paused'), 'x');
  return spawnSync(process.execPath, [WRAPPER], { input: '{"session_id":"s"}', encoding: 'utf8', env: { ...process.env, CLAWAD_DATA: data } });
}

test('기존 status line 출력을 한 줄로 정리하고 pause에서도 유지한다', () => {
  const data = fixture("console.log('branch main\\n비용 10')");
  const result = run(data);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), 'branch main 비용 10');
});

test('실패·지연·셸 메타문자 명령은 실행하지 않고 안전하게 fallback한다', () => {
  for (const command of ['node bad.js; echo injected', 'node bad.js | more']) {
    const data = fixture('');
    fs.writeFileSync(path.join(data, 'statusline-composition.json'), JSON.stringify({ version: 1, originalCommand: command }));
    const result = run(data, false);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /clawad:/);
    assert.doesNotMatch(result.stdout, /injected/);
  }
});

test('느린 기존 명령은 timeout 후 status line을 막지 않는다', () => {
  const data = fixture("setTimeout(() => console.log('late'), 2000)");
  const startedAt = Date.now();
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.ok(Date.now() - startedAt < 1500);
  assert.match(result.stdout, /clawad:/);
});

test('OSC와 다중행을 제거하고 출력 폭을 제한한다', () => {
  const data = fixture("console.log('ok\\x1b]8;;https://evil.test\\x07link\\n'+'x'.repeat(300))");
  const result = run(data);
  assert.strictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /evil\.test|\\n.+\\n/);
  assert.ok(result.stdout.trim().length <= 160);
});

test('정상 실행에서는 기존 출력과 clawad 출력을 조합하고 전체 폭을 제한한다', () => {
  const data = fixture("console.log('branch-main-' + 'x'.repeat(140))");
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^branch-main-/);
  assert.match(result.stdout, / \| /);
  assert.ok(result.stdout.trim().length <= 160);
});

test('SGR 외의 ESC 제어 시퀀스와 미종결 제어 문자열을 제거한다', () => {
  const data = fixture("console.log('safe\\x1bPpayload\\x1b\\\\after\\x1b_hidden\\x1b\\\\ok\\x1b[2Jend\\x1b]unterminated')");
  const result = run(data);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), 'safeafterokend');
  assert.doesNotMatch(result.stdout, /payload|hidden|unterminated|\\x1b/);
});

test('일시중지 중 기존 출력이 없으면 광고나 안내를 대신 표시하지 않는다', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-wrapper-empty-'));
  fs.writeFileSync(path.join(data, 'statusline-composition.json'), JSON.stringify({ version: 1, originalCommand: null }));
  const result = run(data);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '\n');
});
