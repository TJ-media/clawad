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

function run(data, paused = true, extraEnv = {}) {
  if (paused) fs.writeFileSync(path.join(data, 'paused'), 'x');
  return spawnSync(process.execPath, [WRAPPER], { input: '{"session_id":"s"}', encoding: 'utf8', env: { ...process.env, CLAWAD_DATA: data, ...extraEnv } });
}

function withAd(data, overrides = {}) {
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([{
    serveToken: 'payload.test',
    expiresAt: Date.now() + 60_000,
    ad: { campaignId: 'c', creativeId: 'cr', text: '클릭 광고', brand: '클로애드', label: '광고', campaignType: 'PAID' },
    minViewMs: 5000,
    clickUrl: 'https://click.example.test/path',
    ...overrides,
  }]));
  return data;
}

function visibleText(value) {
  return value
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim();
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

test('정상 설치 wrapper는 검증된 HTTPS 광고 링크를 보존하고 기존 출력의 OSC는 제거한다', () => {
  const data = withAd(fixture("console.log('branch\\x1b]8;;https://evil.test\\x1b\\link\\x1b]8;;\\x1b\\')"));
  const result = run(data, false, { WT_SESSION: 'test', TERM: 'xterm-256color' });
  assert.strictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /evil\.test/);
  assert.match(result.stdout, /\x1b\]8;;https:\/\/click\.example\.test\/path\x1b\\클릭 광고\x1b\]8;;\x1b\\/);
});

test('긴 기존 출력에서도 광고 식별 문구와 별도 표시 예산을 유지한다', () => {
  const data = withAd(fixture("console.log('기존-' + 'x'.repeat(300))"));
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.match(visibleText(result.stdout), /^기존-/);
  assert.match(visibleText(result.stdout), / \| \[광고\] 클릭 광고/);
  assert.ok(visibleText(result.stdout).length <= 160);
});

test('ANSI와 OSC 링크는 토큰 경계에서 축약하고 닫힘·reset을 보장한다', () => {
  const data = withAd(fixture("console.log('\\x1b[31m기존-' + 'x'.repeat(300))"));
  const result = run(data, false, { WT_SESSION: 'test', TERM: 'xterm-256color' });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /\x1b\[0m \| /);
  assert.match(result.stdout, /\x1b\]8;;\x1b\\/);
  assert.doesNotMatch(result.stdout, /\x1b\](?!8;;)/);
  assert.ok(visibleText(result.stdout).length <= 160);
});

test('wrapper도 SSH·tmux에서는 광고 링크를 평문으로 폴백한다', () => {
  for (const extraEnv of [{ SSH_CONNECTION: 'host 1 host 2', WT_SESSION: 'test' }, { TMUX: '/tmp/tmux', WT_SESSION: 'test' }]) {
    const result = run(withAd(fixture("console.log('기존')")), false, extraEnv);
    assert.strictEqual(result.status, 0);
    assert.match(visibleText(result.stdout), /\[광고\] 클릭 광고/);
    assert.doesNotMatch(result.stdout, /\x1b\]8;;/);
  }
});

test('SGR 외의 ESC 제어 시퀀스와 미종결 제어 문자열을 제거한다', () => {
  const data = fixture("console.log('safe\\x1bPpayload\\x1b\\\\after\\x1b_hidden\\x1b\\\\ok\\x1b[2Jend\\x1b]unterminated')");
  const result = run(data);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), 'safeafterokend');
  assert.doesNotMatch(result.stdout, /payload|hidden|unterminated|\\x1b/);
});

test('win32에서 .cmd 기존 명령도 cmd.exe 경유로 실행해 출력을 조합한다', { skip: process.platform !== 'win32' }, () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-wrapper-cmd-'));
  const script = path.join(data, 'original.cmd');
  fs.writeFileSync(script, '@echo off\r\necho branch-from-cmd\r\n');
  fs.writeFileSync(path.join(data, 'statusline-composition.json'), JSON.stringify({ version: 1, originalCommand: `"${script}"` }));
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /branch-from-cmd/);
  assert.ok(!fs.existsSync(path.join(data, 'statusline-original-failure.json')), '성공 시 실패 기록이 없어야 한다');
});

test('기존 명령 실행 실패는 상태 파일에 기록되고 상태줄 계약은 유지된다', () => {
  const data = fixture('');
  fs.writeFileSync(path.join(data, 'statusline-composition.json'), JSON.stringify({ version: 1, originalCommand: 'clawad-missing-original-xyz statusline' }));
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim().split(/\r?\n/).length, 1);
  assert.match(result.stdout, /clawad:/);
  const failureFile = path.join(data, 'statusline-original-failure.json');
  assert.ok(fs.existsSync(failureFile));
  const failure = JSON.parse(fs.readFileSync(failureFile, 'utf8'));
  assert.match(failure.code, /^(SPAWN_FAILED|NONZERO_EXIT)$/);
  assert.ok(failure.at);
});

test('기존 명령이 다시 성공하면 실패 기록을 지운다', () => {
  const data = fixture("console.log('recovered')");
  const failureFile = path.join(data, 'statusline-original-failure.json');
  fs.writeFileSync(failureFile, JSON.stringify({ code: 'SPAWN_FAILED', detail: 'EINVAL', at: 'x' }));
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /recovered/);
  assert.ok(!fs.existsSync(failureFile));
});

test('메타문자로 거부된 명령은 INVALID_COMMAND로 기록한다', () => {
  const data = fixture('');
  fs.writeFileSync(path.join(data, 'statusline-composition.json'), JSON.stringify({ version: 1, originalCommand: 'node bad.js; echo injected' }));
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /injected/);
  const failure = JSON.parse(fs.readFileSync(path.join(data, 'statusline-original-failure.json'), 'utf8'));
  assert.strictEqual(failure.code, 'INVALID_COMMAND');
});

test('일시중지 중 기존 출력이 없으면 광고나 안내를 대신 표시하지 않는다', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-wrapper-empty-'));
  fs.writeFileSync(path.join(data, 'statusline-composition.json'), JSON.stringify({ version: 1, originalCommand: null }));
  const result = run(data);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '\n');
});
