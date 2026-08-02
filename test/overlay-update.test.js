'use strict';

// 오버레이 갱신 오케스트레이션 (CLAW-160).
// 실제 프로세스·네트워크는 전부 주입으로 갈아끼운다 — 개발자 PC 상태에 의존하지 않는다.

const assert = require('node:assert/strict');
const test = require('node:test');

const { isRunning, updateOverlay, waitForExit } = require('../client/overlay-update');

/** pgrep 스텁. 남은 호출 수만큼 "실행 중"을 돌려준다. */
function pgrepStub(runningTimes) {
  let left = runningTimes;
  const calls = [];
  const run = (file, args) => {
    calls.push({ file, args });
    const running = left > 0;
    left -= 1;
    return { status: running ? 0 : 1, stdout: running ? '4242\n' : '' };
  };
  return { run, calls };
}

const noSleep = () => Promise.resolve();

test('설치 경로로 도는 프로세스만 실행 중으로 본다', () => {
  const { run, calls } = pgrepStub(1);
  assert.strictEqual(isRunning('Claw-Ad', 'darwin', run), true);
  // 이름만 같은 다른 프로세스를 세지 않도록 번들 실행 경로로 찾는다.
  assert.deepStrictEqual(calls[0].args, ['-f', 'Claw-Ad.app/Contents/MacOS/']);
});

test('제품명에 이상한 문자가 있으면 프로세스를 찾지 않는다', () => {
  let called = false;
  const run = () => { called = true; return { status: 0, stdout: '1\n' }; };
  assert.strictEqual(isRunning('Claw-Ad; rm -rf /', 'darwin', run), false);
  assert.strictEqual(called, false);
});

test('종료를 기다렸다가 돌아온다', async () => {
  const { run } = pgrepStub(3);
  const exited = await waitForExit('Claw-Ad', {
    platform: 'darwin', spawnSync: run, sleep: noSleep, intervalMs: 1, timeoutMs: 60000,
  });
  assert.strictEqual(exited, true);
});

test('한도 안에 종료하지 않으면 포기한다 — 반쯤 교체된 앱을 만들지 않는다', async () => {
  const { run } = pgrepStub(Number.MAX_SAFE_INTEGER);
  let clock = 0;
  const exited = await waitForExit('Claw-Ad', {
    platform: 'darwin', spawnSync: run, sleep: noSleep, intervalMs: 1, timeoutMs: 10,
    now: () => (clock += 4),
  });
  assert.strictEqual(exited, false);
});

test('종료를 기다렸다가 갱신하고 다시 띄운다', async () => {
  const relaunched = [];
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    waitForExit: async () => true,
    installOverlay: async (options) => {
      assert.strictEqual(options.allowUpgrade, true, '갱신 경로는 allowUpgrade를 켜야 한다');
      return { status: 'installed', version: '0.1.7', productName: 'Claw-Ad' };
    },
    relaunch: (name) => { relaunched.push(name); return true; },
  });

  assert.strictEqual(result.status, 'updated');
  assert.strictEqual(result.version, '0.1.7');
  assert.deepStrictEqual(relaunched, ['Claw-Ad']);
});

test('오버레이가 안 꺼지면 교체하지 않는다', async () => {
  let installed = false;
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    waitForExit: async () => false,
    installOverlay: async () => { installed = true; return { status: 'installed' }; },
    relaunch: () => true,
  });

  assert.strictEqual(result.status, 'busy');
  assert.strictEqual(installed, false, '실행 중인 앱을 교체하면 안 된다');
});

test('갱신에 실패해도 앱은 다시 띄운다 — 구 버전이 남아 있다', async () => {
  const relaunched = [];
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    waitForExit: async () => true,
    installOverlay: async () => ({ status: 'failed', stage: 'download', message: '끊김' }),
    relaunch: (name) => { relaunched.push(name); return true; },
  });

  assert.strictEqual(result.status, 'failed');
  assert.deepStrictEqual(relaunched, ['Claw-Ad']);
});

test('이미 최신이면 내려받지 않고 다시 띄우기만 한다', async () => {
  const relaunched = [];
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    waitForExit: async () => true,
    installOverlay: async () => ({ status: 'skipped', reason: 'up-to-date', version: '0.1.6' }),
    relaunch: (name) => { relaunched.push(name); return true; },
  });

  assert.strictEqual(result.status, 'up-to-date');
  assert.deepStrictEqual(relaunched, ['Claw-Ad']);
});

test('Windows는 CLI가 갱신하지 않는다 — electron-updater가 서명 없이도 설치까지 한다', async () => {
  const result = await updateOverlay({ platform: 'win32', manifestUrl: 'https://example.test/m.json' });
  assert.strictEqual(result.status, 'unsupported');
});

test('매니페스트 URL이 없으면 건너뛴다 — 소스 실행에서 120MB를 받지 않는다', async () => {
  const result = await updateOverlay({ platform: 'darwin', manifestUrl: '' });
  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'no-manifest-url');
});
