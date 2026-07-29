'use strict';
// CLAW-133 통합 설치. 네트워크·인스톨러 실행은 주입해서 검증한다 — 실제로 110MB를 받거나
// 앱을 설치하지 않는다. 핵심은 "체크섬이 맞지 않으면 실행하지 않는다"와 "실패해도 throw하지
// 않는다"다. 후자가 깨지면 오버레이 문제로 CLI 설치 전체가 실패한다.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  installOverlay,
  installedPaths,
  readManifestFields,
  uninstallOverlay,
} = require('../client/overlay-install');

const INSTALLER = Buffer.from('MZ fake nsis installer payload');
const DIGEST = crypto.createHash('sha256').update(INSTALLER).digest('hex');

function manifest(overrides = {}) {
  return {
    version: '0.1.0',
    installerUrl: 'https://github.com/TJ-media/clawad-overlay/releases/download/v0.1.0/Claw-Ad-Setup-0.1.0-x64.exe',
    sha256: DIGEST,
    bytes: INSTALLER.length,
    platform: 'win32',
    arch: 'x64',
    silentArgs: ['/S'],
    sourceUrl: 'https://github.com/TJ-media/clawad-overlay',
    license: 'AGPL-3.0-only',
    ...overrides,
  };
}

function emptyLocalAppData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-overlay-test-'));
  return { LOCALAPPDATA: dir };
}

function deps(extra = {}) {
  const calls = [];
  return {
    calls,
    options: {
      manifestUrl: 'https://github.com/TJ-media/clawad-overlay/releases/latest/download/overlay-manifest.json',
      platform: 'win32',
      env: emptyLocalAppData(),
      fetchManifest: async () => readManifestFields(manifest()),
      download: async () => INSTALLER,
      spawnSync: (file, args) => { calls.push({ file, args }); return { status: 0 }; },
      ...extra,
    },
  };
}

test('매니페스트를 검증하고 인스톨러를 무인 실행한다', async () => {
  const { calls, options } = deps();

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'installed');
  assert.strictEqual(result.version, '0.1.0');
  assert.strictEqual(result.productName, 'Claw-Ad');
  assert.strictEqual(result.license, 'AGPL-3.0-only');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, ['/S']);
  assert.match(calls[0].file, /Claw-Ad-Setup-0\.1\.0-x64\.exe$/);
});

test('체크섬이 다르면 인스톨러를 실행하지 않는다', async () => {
  const { calls, options } = deps({ download: async () => Buffer.from('tampered payload') });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'verify');
  assert.strictEqual(calls.length, 0, '검증 실패했는데 인스톨러가 실행됐다');
});

test('크기가 매니페스트와 다르면 실행하지 않는다', async () => {
  // 체크섬까지 맞춰도 크기 단정이 먼저 걸린다 — 매니페스트 위조를 두 겹으로 막는다.
  const payload = Buffer.from('MZ different length payload here');
  const { calls, options } = deps({
    fetchManifest: async () => readManifestFields(manifest({
      sha256: crypto.createHash('sha256').update(payload).digest('hex'),
      bytes: INSTALLER.length,
    })),
    download: async () => payload,
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'verify');
  assert.strictEqual(calls.length, 0);
});

test('매니페스트 조회가 실패해도 throw하지 않는다', async () => {
  const { options } = deps({ fetchManifest: async () => { throw new Error('네트워크 없음'); } });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'manifest');
  assert.match(result.message, /네트워크 없음/);
});

test('인스톨러가 0이 아닌 코드로 끝나면 실패로 보고한다', async () => {
  const { options } = deps({ spawnSync: () => ({ status: 1223 }) });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'run');
  assert.match(result.message, /1223/);
});

test('이미 설치돼 있으면 건너뛴다', async () => {
  const env = emptyLocalAppData();
  const { dir, exe } = installedPaths('Claw-Ad', env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(exe, 'already here');
  const { calls, options } = deps({ env });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'already-installed');
  assert.strictEqual(calls.length, 0);
});

test('Windows가 아니면 건너뛴다', async () => {
  const { options } = deps({ platform: 'darwin' });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'unsupported');
  assert.strictEqual(result.reason, 'platform');
});

test('매니페스트 URL이 없으면 아무것도 하지 않는다', async () => {
  const result = await installOverlay({ manifestUrl: '', platform: 'win32' });

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'no-manifest-url');
});

test('환경변수로 오버레이 설치를 건너뛸 수 있다', async () => {
  const { calls, options } = deps({ env: { ...emptyLocalAppData(), CLAWAD_SKIP_OVERLAY_INSTALL: '1' } });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'opt-out');
  assert.strictEqual(calls.length, 0);
});

test('허용되지 않은 silentArgs는 거절한다', () => {
  // 매니페스트가 임의 인수를 넘겨 인스톨러를 다른 모드로 돌리지 못하게 한다.
  assert.throws(() => readManifestFields(manifest({ silentArgs: ['/S', '&& calc.exe'] })), /silentArgs/);
  assert.throws(() => readManifestFields(manifest({ silentArgs: ['--run-as-admin'] })), /silentArgs/);
});

test('HTTPS가 아닌 installerUrl은 거절한다', () => {
  assert.throws(
    () => readManifestFields(manifest({ installerUrl: 'http://example.test/Claw-Ad-Setup-0.1.0-x64.exe' })),
    /installerUrl/
  );
});

test('제품명을 얻을 수 없는 파일명은 거절한다', () => {
  assert.throws(
    () => readManifestFields(manifest({ installerUrl: 'https://example.test/download.exe' })),
    /제품명/
  );
});

test('버전·체크섬 형식을 검증한다', () => {
  assert.throws(() => readManifestFields(manifest({ version: 'latest' })), /version/);
  assert.throws(() => readManifestFields(manifest({ sha256: 'nope' })), /SHA-256/);
  assert.throws(() => readManifestFields(manifest({ bytes: 0 })), /bytes/);
});

test('제거는 제거 프로그램이 있을 때만 실행한다', () => {
  const env = emptyLocalAppData();
  const calls = [];
  const spawnSync = (file, args) => { calls.push({ file, args }); return { status: 0 }; };

  const missing = uninstallOverlay({ env, platform: 'win32', spawnSync });
  assert.strictEqual(missing.status, 'skipped');
  assert.strictEqual(calls.length, 0);

  const { dir } = installedPaths('Claw-Ad', env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Uninstall Claw-Ad.exe'), 'uninstaller');

  const removed = uninstallOverlay({ env, platform: 'win32', spawnSync });
  assert.strictEqual(removed.status, 'removed');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, ['/S']);
});
