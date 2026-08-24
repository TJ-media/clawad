'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUpdater } = require('../client/update');

function activeRelease(version = '0.1.17') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-update-'));
  fs.mkdirSync(path.join(root, 'client'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'install.js'), '\n');
  fs.writeFileSync(path.join(root, 'client', 'overlay-update.js'), '\n');
  return { version, root };
}

test('현재 활성 CLI와 manifest 버전이 같으면 패키지를 설치하지 않는다', async (t) => {
  const previous = activeRelease();
  t.after(() => fs.rmSync(previous.root, { recursive: true, force: true }));
  let packageDownloads = 0;
  let installations = 0;
  const updater = createUpdater({
    activeRelease: () => previous,
    readManifest: async () => ({ version: previous.version, packageUrl: 'https://example.test/clawad.tgz', sha256: 'a'.repeat(64) }),
    download: async () => { packageDownloads += 1; return Buffer.alloc(0); },
    installRelease: async () => { installations += 1; },
  });

  const result = await updater.updateCli({ manifestUrl: 'https://example.test/manifest.json' });

  assert.deepStrictEqual(result, { status: 'up-to-date', version: previous.version, root: previous.root });
  assert.strictEqual(packageDownloads, 0);
  assert.strictEqual(installations, 0);
});

test('새 릴리스 디렉터리를 임시 tarball보다 먼저 만든다', async () => {
  const calls = [];
  const packageBytes = Buffer.from('clawad-package');
  const nextVersion = '0.1.18';
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    readManifest: async () => ({
      version: nextVersion,
      packageUrl: 'https://example.test/clawad.tgz',
      sha256: require('node:crypto').createHash('sha256').update(packageBytes).digest('hex'),
    }),
    download: async () => packageBytes,
    fs: {
      mkdirSync: (file) => calls.push(['mkdir', file]),
      writeFileSync: (file) => calls.push(['write', file]),
      existsSync: (file) => file.endsWith(path.join('client', 'install.js')),
      readFileSync: () => JSON.stringify({ name: '@clawad/cli', version: nextVersion }),
      rmSync: () => {},
      unlinkSync: () => {},
    },
    runNpm: () => ({ status: 0 }),
    runNode: () => ({ status: 0 }),
  });

  await updater.updateCli();

  const releaseDir = calls.findIndex(([operation, file]) =>
    operation === 'mkdir' && file.endsWith(path.join('releases', nextVersion)));
  const tarball = calls.findIndex(([operation, file]) =>
    operation === 'write' && file.endsWith(`.clawad-${nextVersion}.tgz`));
  assert.ok(releaseDir >= 0);
  assert.ok(tarball >= 0);
  assert.ok(releaseDir < tarball);
});

// npm install 도중 프로세스가 죽으면 releases/<버전>/이 남고, 지우지 않으면 그 버전으로의
// 업데이트가 다음 릴리스까지 영구 차단된다 (CLAW-263).
function remnantUpdater(mtimeMs, removed) {
  const packageBytes = Buffer.from('retry-package');
  const nextVersion = '0.1.18';
  return createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    readManifest: async () => ({
      version: nextVersion,
      packageUrl: 'https://example.test/clawad.tgz',
      sha256: require('node:crypto').createHash('sha256').update(packageBytes).digest('hex'),
    }),
    download: async () => packageBytes,
    fs: {
      existsSync: (file) => file.endsWith(path.join('releases', nextVersion)) || file.endsWith(path.join('client', 'install.js')),
      statSync: () => ({ mtimeMs }),
      rmSync: (file) => removed.push(file),
      mkdirSync: () => {},
      writeFileSync: () => {},
      readFileSync: () => JSON.stringify({ name: '@clawad/cli', version: nextVersion }),
      unlinkSync: () => {},
    },
    runNpm: () => ({ status: 0 }),
    runNode: () => ({ status: 0 }),
  });
}

test('중단된 설치의 오래된 잔재는 지우고 다시 설치한다 (CLAW-263)', async () => {
  const removed = [];
  const updater = remnantUpdater(Date.now() - 16 * 60 * 1000, removed);

  const result = await updater.updateCli();

  assert.strictEqual(result.status, 'updated');
  assert.ok(removed.some((file) => file.endsWith(path.join('releases', '0.1.18'))), '잔재를 지우고 진행해야 한다');
});

test('갓 만들어진 설치 디렉터리는 지우지 않는다 — 다른 프로세스가 설치 중일 수 있다 (CLAW-263)', async () => {
  const removed = [];
  const updater = remnantUpdater(Date.now(), removed);

  await assert.rejects(() => updater.updateCli(), /이미 설치 중/);
  assert.strictEqual(removed.length, 0);
});

test('늦게 도착한 업데이트는 다른 프로세스가 활성화한 버전을 되돌리지 않는다', async () => {
  const packageBytes = Buffer.from('concurrent-package');
  const previous = { version: '0.1.17', root: 'old-root' };
  const target = { version: '0.1.18', root: 'new-root' };
  const installs = [];
  let unlinks = 0;
  let active = previous;
  const updater = createUpdater({
    activeRelease: () => active,
    readManifest: async () => ({
      version: target.version,
      packageUrl: 'https://example.test/clawad.tgz',
      sha256: require('node:crypto').createHash('sha256').update(packageBytes).digest('hex'),
    }),
    download: async () => packageBytes,
    fs: {
      mkdirSync: (file) => {
        if (!file.endsWith(path.join('releases', target.version))) return;
        active = target;
        const error = new Error('release already exists');
        error.code = 'EEXIST';
        throw error;
      },
      writeFileSync: () => {},
      existsSync: () => false,
      readFileSync: () => JSON.stringify({ name: '@clawad/cli', version: target.version }),
      rmSync: () => {},
      unlinkSync: () => { unlinks += 1; },
    },
    runNpm: () => ({ status: 0 }),
    runNode: (script) => {
      installs.push(script);
      if (script === path.join(previous.root, 'client', 'install.js')) active = previous;
      return { status: 0 };
    },
  });

  const result = await updater.updateCli();

  assert.deepStrictEqual(result, { status: 'up-to-date', version: target.version, root: target.root });
  assert.deepStrictEqual(installs, []);
  assert.strictEqual(unlinks, 0);
  assert.deepStrictEqual(active, target);
});

test('macOS는 CLI 루트의 overlay-update.js를 실행한다', async () => {
  const calls = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    updateCli: async () => ({ status: 'updated', version: '0.1.18', root: 'new-root' }),
    runNode: (script) => { calls.push(script); return { status: 0 }; },
  });
  const result = await updater.run({ platform: 'darwin' });
  assert.strictEqual(calls[0], path.join('new-root', 'client', 'overlay-update.js'));
  assert.strictEqual(result.overlay.status, 'updated');
});

test('macOS에서 CLI 실패 시 기존 CLI로 오버레이는 갱신하되 실패로 보고한다 (CLAW-264)', async () => {
  const calls = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    updateCli: async () => { throw new Error('cli failed'); },
    runNode: (script) => { calls.push(script); return { status: 0 }; },
    stderr: () => {},
  });
  // 오버레이 갱신은 기존 CLI로 계속하고, 최종 결과는 성공(exit 0)으로 삼키지 않는다.
  await assert.rejects(() => updater.run({ platform: 'darwin' }), /cli failed/);
  assert.strictEqual(calls[0], path.join('old-root', 'client', 'overlay-update.js'));
});

test('명령 실행 성공은 주입한 stdout으로 보고한다', async () => {
  const output = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    updateCli: async () => ({ status: 'up-to-date', version: '0.1.17', root: 'old-root' }),
    stdout: (line) => output.push(line),
  });

  await updater.run({ platform: 'win32', report: true });

  assert.match(output[0], /0\.1\.17/);
});

test('명령 실행 실패는 주입한 stderr으로 보고한다', async () => {
  const output = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    updateCli: async () => { throw new Error('cli failed'); },
    stderr: (line) => output.push(line),
  });

  await assert.rejects(updater.run({ platform: 'win32', report: true }), /cli failed/);

  assert.match(output[0], /cli failed/);
});

test('Windows는 오버레이 교체 스크립트를 실행하지 않고 CLI 실패를 전달한다', async () => {
  let overlayRuns = 0;
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    updateCli: async () => { throw new Error('cli failed'); },
    runNode: () => { overlayRuns += 1; return { status: 0 }; },
  });
  await assert.rejects(updater.run({ platform: 'win32' }), /cli failed/);
  assert.strictEqual(overlayRuns, 0);
});

test('Windows update는 설치된 오버레이를 실행한다 (CLAW-239)', async (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-update-overlay-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const target = path.join(localAppData, 'Programs', 'Claw-Ad', 'Claw-Ad.exe');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'installed');
  const launches = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.2.6', root: 'active-root' }),
    updateCli: async () => ({ status: 'up-to-date', version: '0.2.6', root: 'active-root' }),
    env: { LOCALAPPDATA: localAppData },
    relaunchOverlay: (name, options) => { launches.push({ name, options }); return true; },
  });

  await updater.run({ platform: 'win32' });

  assert.strictEqual(launches.length, 1);
  assert.strictEqual(launches[0].name, 'Claw-Ad');
  assert.strictEqual(launches[0].options.platform, 'win32');
});

test('Windows update는 오버레이 opt-out을 존중한다 (CLAW-239)', async (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-update-overlay-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const target = path.join(localAppData, 'Programs', 'Claw-Ad', 'Claw-Ad.exe');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'installed');
  let launches = 0;
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.2.6', root: 'active-root' }),
    updateCli: async () => ({ status: 'up-to-date', version: '0.2.6', root: 'active-root' }),
    env: { LOCALAPPDATA: localAppData, CLAWAD_SKIP_OVERLAY_INSTALL: '1' },
    relaunchOverlay: () => { launches += 1; return true; },
  });

  await updater.run({ platform: 'win32' });

  assert.strictEqual(launches, 0);
});

test('Windows 오버레이 실행 실패는 update를 실패시키지 않고 경고한다 (CLAW-239)', async (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-update-overlay-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const target = path.join(localAppData, 'Programs', 'Claw-Ad', 'Claw-Ad.exe');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'installed');
  const warnings = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.2.6', root: 'active-root' }),
    updateCli: async () => ({ status: 'up-to-date', version: '0.2.6', root: 'active-root' }),
    env: { LOCALAPPDATA: localAppData },
    relaunchOverlay: () => false,
    stderr: (line) => warnings.push(line),
  });

  const result = await updater.run({ platform: 'win32' });

  assert.strictEqual(result.cli.status, 'up-to-date');
  assert.ok(warnings.some((line) => /오버레이.*실행/.test(line)));
});

test('Windows 오버레이의 비동기 시작 실패도 update 이후 경고한다 (CLAW-239)', async (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-update-overlay-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const target = path.join(localAppData, 'Programs', 'Claw-Ad', 'Claw-Ad.exe');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'installed');
  const warnings = [];
  let launchOptions;
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.2.6', root: 'active-root' }),
    updateCli: async () => ({ status: 'up-to-date', version: '0.2.6', root: 'active-root' }),
    env: { LOCALAPPDATA: localAppData },
    relaunchOverlay: (name, options) => { launchOptions = options; return true; },
    stderr: (line) => warnings.push(line),
  });

  const result = await updater.run({ platform: 'win32' });
  assert.strictEqual(typeof launchOptions.onError, 'function');
  launchOptions.onError(new Error('start denied'));

  assert.strictEqual(result.cli.status, 'up-to-date');
  assert.ok(warnings.some((line) => /오버레이.*실행/.test(line)));
});

// 전역 명령 갱신이 릴리스 설치의 부수 효과라, 한 번 실패하면 릴리스가 최신인 동안에는
// 다시 시도되지 않았다. 실측: 릴리스 0.1.22 / 전역 명령 0.1.20 (CLAW-211).
function updaterWithBinary({ available = true, installedVersion, cliStatus = 'up-to-date' }) {
  const installs = [];
  const logs = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.2.0', root: '/tmp/none' }),
    updateCli: async () => ({ status: cliStatus, version: '0.2.0', root: '/tmp/none' }),
    cliBinaryAvailable: () => available,
    cliBinaryVersion: () => installedVersion,
    installCliBinary: (data, spec) => { installs.push(spec); return { installed: true, skipped: false }; },
    runNode: () => ({ status: 0 }),
    stdout: (line) => logs.push(line),
  });
  return { updater, installs, logs };
}

test('릴리스가 최신이어도 전역 명령이 뒤처졌으면 다시 설치한다 (CLAW-211)', async () => {
  const { updater, installs, logs } = updaterWithBinary({ installedVersion: '0.1.20' });

  await updater.run({ platform: 'darwin' });

  assert.deepStrictEqual(installs, ['@clawad/cli@0.2.0']);
  assert.ok(logs.some((l) => /전역 clawad 명령을 0\.2\.0으로 맞췄습니다/.test(l)));
});

test('전역 명령이 이미 같은 버전이면 건드리지 않는다 (CLAW-211)', async () => {
  const { updater, installs } = updaterWithBinary({ installedVersion: '0.2.0' });

  await updater.run({ platform: 'darwin' });

  assert.deepStrictEqual(installs, []);
});

// 전역 설치는 선택 단계다(CLAW-103). 설치한 적 없는 기기에 슬쩍 넣지 않는다.
test('전역 명령을 설치한 적이 없으면 새로 넣지 않는다 (CLAW-211)', async () => {
  const { updater, installs } = updaterWithBinary({ available: false, installedVersion: '' });

  await updater.run({ platform: 'darwin' });

  assert.deepStrictEqual(installs, []);
});

// 0.2.0 이전 기록에는 버전이 없다. 모르는 상태이므로 한 번 맞춰 둔다.
test('기록에 버전이 없으면 한 번 맞춘다 (CLAW-211)', async () => {
  const { updater, installs } = updaterWithBinary({ installedVersion: '' });

  await updater.run({ platform: 'darwin' });

  assert.deepStrictEqual(installs, ['@clawad/cli@0.2.0']);
});
