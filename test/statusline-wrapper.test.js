'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

/** 대기 중 안내문 대신 광고를 렌더링하도록 세션을 활성 상태로 만든다. */
function activateWork(data, sessionId = 's') {
  const key = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  const dir = path.join(data, 'work-state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
    version: 1, active: true, startedAt: Date.now() - 6000, intervals: [], updatedAt: Date.now(),
  }));
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
  const data = activateWork(withAd(fixture("console.log('branch\\x1b]8;;https://evil.test\\x1b\\link\\x1b]8;;\\x1b\\')")));
  const result = run(data, false, { WT_SESSION: 'test', TERM: 'xterm-256color' });
  assert.strictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /evil\.test/);
  assert.match(result.stdout, /\x1b\]8;;https:\/\/click\.example\.test\/path\x1b\\클릭 광고\x1b\]8;;\x1b\\/);
});

test('긴 기존 출력에서도 광고 식별 문구와 별도 표시 예산을 유지한다', () => {
  const data = activateWork(withAd(fixture("console.log('기존-' + 'x'.repeat(300))")));
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.match(visibleText(result.stdout), /^기존-/);
  assert.match(visibleText(result.stdout), / \| \[광고\] 클릭 광고/);
  assert.ok(visibleText(result.stdout).length <= 160);
});

test('ANSI와 OSC 링크는 토큰 경계에서 축약하고 닫힘·reset을 보장한다', () => {
  const data = activateWork(withAd(fixture("console.log('\\x1b[31m기존-' + 'x'.repeat(300))")));
  const result = run(data, false, { WT_SESSION: 'test', TERM: 'xterm-256color' });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /\x1b\[0m \| /);
  assert.match(result.stdout, /\x1b\]8;;\x1b\\/);
  assert.doesNotMatch(result.stdout, /\x1b\](?!8;;)/);
  assert.ok(visibleText(result.stdout).length <= 160);
});

test('wrapper도 SSH·tmux에서는 광고 링크를 평문으로 폴백한다', () => {
  for (const extraEnv of [{ SSH_CONNECTION: 'host 1 host 2', WT_SESSION: 'test' }, { TMUX: '/tmp/tmux', WT_SESSION: 'test' }]) {
    const result = run(activateWork(withAd(fixture("console.log('기존')"))), false, extraEnv);
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

// --- 오버레이 서피스 락 (CLAW-91) ---

/** 살아 있는 소유자(이 테스트 프로세스)가 잡은 서피스 락을 만든다. */
function holdSurfaceLock(data) {
  fs.writeFileSync(path.join(data, 'surface.lock'), JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), owner: 'overlay',
  }));
}

test('오버레이가 서피스를 소유하면 광고를 렌더하지 않고 기존 출력만 통과시킨다', () => {
  const data = withAd(activateWork(fixture("console.log('branch main')")));
  holdSurfaceLock(data);
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(visibleText(result.stdout), 'branch main');
  assert.doesNotMatch(result.stdout, /광고/, '오버레이 소유 중에는 statusline이 광고를 표시하지 않는다');
});

test('오버레이 소유 중에는 노출 이벤트를 만들지 않는다 — 락 소유자만 방출한다', () => {
  const data = withAd(activateWork(fixture("console.log('branch main')")));
  holdSurfaceLock(data);
  run(data, false);
  assert.ok(!fs.existsSync(path.join(data, 'ledger.jsonl')), '원장에 노출이 추가되지 않아야 한다');
  assert.ok(!fs.existsSync(path.join(data, 'session-state')), '세션 상태를 만들지 않아야 한다');
});

test('오버레이가 비정상 종료해 stale 락이 남으면 광고 렌더를 재개한다', () => {
  const data = withAd(activateWork(fixture("console.log('branch main')")));
  // 죽은 pid = 소유자 없음. 광고가 영구히 사라지는 상태를 만들지 않는다.
  fs.writeFileSync(path.join(data, 'surface.lock'), JSON.stringify({
    pid: 0x7ffffffe, startedAt: new Date().toISOString(), owner: 'overlay',
  }));
  const result = run(data, false);
  assert.strictEqual(result.status, 0);
  assert.match(visibleText(result.stdout), /\[광고\]/, 'stale 락에서는 광고 표기가 다시 나와야 한다');
});

test('오버레이가 락을 반환하면 statusline이 광고를 이어받는다', () => {
  const data = withAd(activateWork(fixture("console.log('branch main')")));
  holdSurfaceLock(data);
  assert.doesNotMatch(run(data, false).stdout, /\[광고\]/);
  // 일시중지·정상 종료 시 오버레이는 락을 반환한다.
  fs.unlinkSync(path.join(data, 'surface.lock'));
  assert.match(visibleText(run(data, false).stdout), /\[광고\]/);
});
