'use strict';

// 오버레이 갱신 오케스트레이션 (CLAW-160).
// 실제 프로세스·네트워크는 전부 주입으로 갈아끼운다 — 개발자 PC 상태에 의존하지 않는다.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const { isRunning, relaunch, updateOverlay, waitForExit } = require('../client/overlay-update');

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

test('opt-out 환경은 갱신을 건너뛰고 성공으로 끝난다 (CLAW-265)', async () => {
  let fetched = false;
  let waited = false;
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    env: { CLAWAD_SKIP_OVERLAY_INSTALL: '1' },
    fetchManifest: async () => { fetched = true; return {}; },
    waitForExit: async () => { waited = true; return true; },
    installOverlay: async () => ({ status: 'installed' }),
    relaunch: () => true,
  });
  // install 경로처럼 사용자의 선택을 존중한다 — 실패가 아니라 갱신할 것이 없는 상태다.
  assert.deepStrictEqual(result, { status: 'skipped', reason: 'opt-out' });
  assert.strictEqual(fetched, false, '갱신할 것이 없는데 매니페스트를 받으면 안 된다');
  assert.strictEqual(waited, false, '종료를 기다릴 이유가 없다 (CLAW-215)');
});

test('매니페스트 URL이 없으면 건너뛴다 — 소스 실행에서 120MB를 받지 않는다', async () => {
  const result = await updateOverlay({ platform: 'darwin', manifestUrl: '' });
  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'no-manifest-url');
});

// 오버레이는 트레이 상주가 정상 상태다. 갱신할 게 없는데 종료부터 기다리면 60초를 버리고
// busy로 끝나, 터미널에서 치는 `clawad update`가 항상 실패한다 (CLAW-215).
test('이미 최신이면 종료를 기다리지 않는다 (CLAW-215)', async () => {
  let waited = false;
  const relaunched = [];
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    fetchManifest: async () => ({ version: '0.1.14', productName: 'Claw-Ad', platform: 'darwin' }),
    readInstalledVersion: () => '0.1.14',
    waitForExit: async () => { waited = true; return false; },
    isRunning: () => true,
    installOverlay: async () => ({ status: 'skipped', reason: 'up-to-date', version: '0.1.14' }),
    relaunch: (name) => { relaunched.push(name); return true; },
  });

  assert.strictEqual(result.status, 'up-to-date');
  assert.strictEqual(waited, false, '갱신할 것이 없으면 종료를 기다리지 않는다');
  assert.deepStrictEqual(relaunched, [], '종료를 요청하지 않았으니 다시 띄울 것도 없다');
});

test('이미 최신이어도 macOS 앱이 꺼져 있으면 띄운다 (CLAW-239)', async () => {
  const relaunched = [];
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    fetchManifest: async () => ({ version: '0.1.14', productName: 'Claw-Ad', platform: 'darwin' }),
    readInstalledVersion: () => '0.1.14',
    isRunning: () => false,
    installOverlay: async () => ({ status: 'skipped', reason: 'up-to-date', version: '0.1.14' }),
    relaunch: (name) => { relaunched.push(name); return true; },
  });

  assert.strictEqual(result.status, 'up-to-date');
  assert.deepStrictEqual(relaunched, ['Claw-Ad']);
});

test('버전이 다르면 예전대로 종료를 기다린다 (CLAW-215)', async () => {
  let waited = false;
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    fetchManifest: async () => ({ version: '0.2.0', productName: 'Claw-Ad', platform: 'darwin' }),
    readInstalledVersion: () => '0.1.14',
    waitForExit: async () => { waited = true; return true; },
    installOverlay: async () => ({ status: 'installed', version: '0.2.0', productName: 'Claw-Ad' }),
    relaunch: () => true,
  });

  assert.strictEqual(result.status, 'updated');
  assert.strictEqual(waited, true);
});

// 사전 판정과 installOverlay가 서로 다른 근거를 쓰면 한쪽은 반드시 틀린다 (CLAW-284).
// 반쪽만 갱신된 기기는 번들 버전이 최신이라고 말하므로, 버전으로 판정하면 종료를 기다리지 않고
// **실행 중인 앱의 asar를 갈아버린다.**
test('갈 조각이 남아 있으면 버전이 같아도 종료를 기다린다 (CLAW-284)', async () => {
  let waited = false;
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    fetchManifest: async () => ({ version: '0.2.13', productName: 'Claw-Ad', platform: 'darwin' }),
    readInstalledVersion: () => '0.2.13',
    pendingPieces: () => ({ asar: false, unpacked: true }),
    waitForExit: async () => { waited = true; return true; },
    installOverlay: async () => ({ status: 'installed', version: '0.2.13', productName: 'Claw-Ad' }),
    relaunch: () => true,
  });

  assert.strictEqual(result.status, 'updated');
  assert.strictEqual(waited, true, '앱을 세운 뒤에 갈아야 한다');
});

test('갈 조각이 없으면 버전 표기가 낡았어도 기다리지 않는다 (CLAW-284)', async () => {
  let waited = false;
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    fetchManifest: async () => ({ version: '0.2.13', productName: 'Claw-Ad', platform: 'darwin' }),
    readInstalledVersion: () => '0.2.11',
    pendingPieces: () => ({ asar: false, unpacked: false }),
    waitForExit: async () => { waited = true; return false; },
    isRunning: () => true,
    installOverlay: async () => ({ status: 'skipped', reason: 'up-to-date', version: '0.2.13' }),
    relaunch: () => true,
  });

  assert.strictEqual(result.status, 'up-to-date');
  assert.strictEqual(waited, false);
});

// 확인하지 못한 것을 "갱신 없음"으로 삼으면, 매니페스트가 잠깐 안 뜨는 사이 갱신이 조용히 멈춘다.
test('매니페스트 확인에 실패하면 예전 흐름으로 간다 (CLAW-215)', async () => {
  let waited = false;
  const result = await updateOverlay({
    platform: 'darwin',
    manifestUrl: 'https://example.test/overlay-manifest.json',
    fetchManifest: async () => { throw new Error('끊김'); },
    readInstalledVersion: () => '0.1.14',
    waitForExit: async () => { waited = true; return true; },
    installOverlay: async () => ({ status: 'installed', version: '0.1.14', productName: 'Claw-Ad' }),
    relaunch: () => true,
  });

  assert.strictEqual(waited, true, '판단하지 못했으면 기다렸다가 교체를 시도한다');
  assert.strictEqual(result.status, 'updated');
});

// 설치 직후 첫 실행은 Windows에서도 일어나야 한다 (CLAW-227). 갱신 경로는 darwin에서만 도는데,
// 그동안 relaunch가 darwin 전용이라 설치가 앱을 띄울 수단이 없었다.
test('win32 relaunch는 설치 경로의 실행 파일을 detached로 띄운다 (CLAW-227)', () => {
  const calls = [];
  const child = { on() {}, unref() {} };
  const target = __filename; // 존재하는 파일이면 된다 — 실행하지 않는다
  const launched = relaunch('Claw-Ad', {
    platform: 'win32',
    installedPaths: () => ({ dir: 'ignored', target }),
    spawn: (file, args, opts) => { calls.push({ file, args, opts }); return child; },
  });
  assert.strictEqual(launched, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].file, target, '이름이 아니라 설치 경로를 실행해야 한다');
  assert.deepStrictEqual(calls[0].args, []);
  assert.strictEqual(calls[0].opts.detached, true);
  assert.strictEqual(calls[0].opts.shell, false);
});

test('relaunch는 비동기 프로세스 시작 실패를 호출자에게 알린다 (CLAW-239)', () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const errors = [];
  const launched = relaunch('Claw-Ad', {
    platform: 'win32',
    installedPaths: () => ({ dir: 'ignored', target: __filename }),
    spawn: () => child,
    onError: (error) => errors.push(error.message),
  });

  child.emit('error', new Error('start denied'));

  assert.strictEqual(launched, true, 'spawn 호출 자체는 성공했으므로 비동기 오류로 보고한다');
  assert.deepStrictEqual(errors, ['start denied']);
});

test('win32 relaunch는 설치본이 없으면 띄우지 않는다 (CLAW-227)', () => {
  const calls = [];
  const launched = relaunch('Claw-Ad', {
    platform: 'win32',
    installedPaths: () => ({ dir: 'ignored', target: path.join(__dirname, '없는-파일.exe') }),
    spawn: (file) => { calls.push(file); return { on() {}, unref() {} }; },
  });
  assert.strictEqual(launched, false);
  assert.deepStrictEqual(calls, []);
});

test('relaunch는 제품명에 이상한 문자가 있으면 실행하지 않는다', () => {
  const calls = [];
  const spawn = (file) => { calls.push(file); return { on() {}, unref() {} }; };
  assert.strictEqual(relaunch('Claw-Ad; calc.exe', { platform: 'win32', spawn }), false);
  assert.strictEqual(relaunch('Claw-Ad; open /', { platform: 'darwin', spawn }), false);
  assert.deepStrictEqual(calls, []);
});

test('relaunch는 지원하지 않는 플랫폼에서 아무것도 하지 않는다', () => {
  assert.strictEqual(relaunch('Claw-Ad', { platform: 'linux', spawn: () => { throw new Error('불려선 안 된다'); } }), false);
});
