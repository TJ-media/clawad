'use strict';
// CLAW-133 통합 설치. 네트워크·인스톨러 실행은 주입해서 검증한다 — 실제로 110MB를 받거나
// 앱을 설치하지 않는다. 핵심은 "체크섬이 맞지 않으면 실행하지 않는다"와 "실패해도 throw하지
// 않는다"다. 후자가 깨지면 오버레이 문제로 CLI 설치 전체가 실패한다.
// CLAW-92에서 macOS(zip → ~/Applications)를 같은 흐름에 넣었다.
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
const RELEASE = 'https://github.com/TJ-media/clawad-overlay/releases/download/v0.1.0';

// CLAW-92 이후의 매니페스트. 플랫폼·아키텍처별 산출물을 artifacts에 담는다.
function manifest(overrides = {}, artifactOverrides = {}) {
  return {
    version: '0.1.0',
    sourceUrl: 'https://github.com/TJ-media/clawad-overlay',
    license: 'AGPL-3.0-only',
    artifacts: {
      'win32-x64': {
        installerUrl: `${RELEASE}/Claw-Ad-Setup-0.1.0-x64.exe`,
        sha256: DIGEST,
        bytes: INSTALLER.length,
        kind: 'nsis',
        silentArgs: ['/S'],
        productName: 'Claw-Ad',
        ...(artifactOverrides['win32-x64'] || {}),
      },
      'darwin-arm64': {
        installerUrl: `${RELEASE}/Claw-Ad-0.1.0-arm64.zip`,
        sha256: DIGEST,
        bytes: INSTALLER.length,
        kind: 'zip',
        productName: 'Claw-Ad',
        ...(artifactOverrides['darwin-arm64'] || {}),
      },
    },
    ...overrides,
  };
}

// v0.1.1까지 게시된 평평한 win32 전용 매니페스트.
function legacyManifest(overrides = {}) {
  return {
    version: '0.1.0',
    installerUrl: `${RELEASE}/Claw-Ad-Setup-0.1.0-x64.exe`,
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

function emptyHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-overlay-test-'));
  return { HOME: dir };
}

function deps(extra = {}) {
  const calls = [];
  const platform = extra.platform || 'win32';
  const arch = extra.arch || 'x64';
  return {
    calls,
    options: {
      manifestUrl: 'https://github.com/TJ-media/clawad-overlay/releases/latest/download/overlay-manifest.json',
      platform,
      arch,
      env: platform === 'darwin' ? emptyHome() : emptyLocalAppData(),
      fetchManifest: async () => readManifestFields(manifest(), { platform, arch }),
      download: async () => INSTALLER,
      spawnSync: (file, args) => { calls.push({ file, args }); return { status: 0 }; },
      ...extra,
    },
  };
}

// macOS는 ditto가 실제로 번들을 만들어야 성공으로 친다. 압축 해제를 흉내 낸다.
function dittoStub(calls, env, { createBundle = true } = {}) {
  return (file, args) => {
    calls.push({ file, args });
    if (createBundle && file === '/usr/bin/ditto') {
      const dest = args[3];
      fs.mkdirSync(path.join(dest, 'Claw-Ad.app', 'Contents'), { recursive: true });
    }
    return { status: 0 };
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

test('macOS는 zip을 사용자 Applications에 푼다', async () => {
  const env = emptyHome();
  const calls = [];
  const { options } = deps({ platform: 'darwin', arch: 'arm64', env, spawnSync: dittoStub(calls, env) });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'installed');
  assert.strictEqual(result.productName, 'Claw-Ad');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].file, '/usr/bin/ditto');
  assert.deepStrictEqual(calls[0].args.slice(0, 2), ['-x', '-k']);
  assert.match(calls[0].args[2], /Claw-Ad-0\.1\.0-arm64\.zip$/);
  assert.strictEqual(calls[0].args[3], path.join(env.HOME, 'Applications'));
  assert.ok(fs.existsSync(path.join(env.HOME, 'Applications', 'Claw-Ad.app')));
});

test('macOS에서 압축을 풀어도 번들이 없으면 실패로 보고한다', async () => {
  const env = emptyHome();
  const calls = [];
  const { options } = deps({
    platform: 'darwin', arch: 'arm64', env,
    spawnSync: dittoStub(calls, env, { createBundle: false }),
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'run');
  assert.match(result.message, /앱 번들이 없습니다/);
});

test('매니페스트에 없는 아키텍처는 실패로 보고한다', async () => {
  // darwin-x64 산출물을 올리지 않은 릴리스를 인텔 맥에서 만난 경우.
  const { options } = deps({
    platform: 'darwin',
    arch: 'x64',
    fetchManifest: async () => readManifestFields(manifest(), { platform: 'darwin', arch: 'x64' }),
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'manifest');
  assert.match(result.message, /darwin-x64/);
});

test('예전 평평한 win32 매니페스트도 읽는다', () => {
  const fields = readManifestFields(legacyManifest(), { platform: 'win32', arch: 'x64' });

  assert.strictEqual(fields.kind, 'nsis');
  assert.strictEqual(fields.productName, 'Claw-Ad');
  assert.deepStrictEqual(fields.silentArgs, ['/S']);
});

test('예전 매니페스트에는 macOS 산출물이 없다', () => {
  assert.throws(
    () => readManifestFields(legacyManifest(), { platform: 'darwin', arch: 'arm64' }),
    /darwin-arm64/
  );
});

test('체크섬이 다르면 인스톨러를 실행하지 않는다', async () => {
  const { calls, options } = deps({ download: async () => Buffer.from('tampered payload') });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'verify');
  assert.strictEqual(calls.length, 0, '검증 실패했는데 인스톨러가 실행됐다');
});

test('macOS도 체크섬이 다르면 압축을 풀지 않는다', async () => {
  const env = emptyHome();
  const calls = [];
  const { options } = deps({
    platform: 'darwin', arch: 'arm64', env,
    spawnSync: dittoStub(calls, env),
    download: async () => Buffer.from('tampered payload'),
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'verify');
  assert.strictEqual(calls.length, 0, '검증 실패했는데 압축을 풀었다');
});

test('크기가 매니페스트와 다르면 실행하지 않는다', async () => {
  // 체크섬까지 맞춰도 크기 단정이 먼저 걸린다 — 매니페스트 위조를 두 겹으로 막는다.
  const payload = Buffer.from('MZ different length payload here');
  const { calls, options } = deps({
    fetchManifest: async () => readManifestFields(
      manifest({}, { 'win32-x64': { sha256: crypto.createHash('sha256').update(payload).digest('hex') } }),
      { platform: 'win32', arch: 'x64' }
    ),
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
  const { dir, target } = installedPaths('Claw-Ad', env, 'win32');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, 'already here');
  const { calls, options } = deps({ env });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'already-installed');
  assert.strictEqual(calls.length, 0);
});

test('macOS도 앱 번들이 있으면 건너뛴다', async () => {
  const env = emptyHome();
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  fs.mkdirSync(target, { recursive: true });
  const calls = [];
  const { options } = deps({ platform: 'darwin', arch: 'arm64', env, spawnSync: dittoStub(calls, env) });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'already-installed');
  assert.strictEqual(calls.length, 0);
});

test('지원하지 않는 플랫폼은 건너뛴다', async () => {
  const { options } = deps({ platform: 'linux' });

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
  const win = { platform: 'win32', arch: 'x64' };
  assert.throws(
    () => readManifestFields(manifest({}, { 'win32-x64': { silentArgs: ['/S', '&& calc.exe'] } }), win),
    /silentArgs/
  );
  assert.throws(
    () => readManifestFields(manifest({}, { 'win32-x64': { silentArgs: ['--run-as-admin'] } }), win),
    /silentArgs/
  );
});

test('zip 산출물에는 silentArgs를 쓸 수 없다', () => {
  // 압축만 푸는 경로로 인수를 실어 보내 다른 프로그램을 돌리지 못하게 한다.
  assert.throws(
    () => readManifestFields(
      manifest({}, { 'darwin-arm64': { silentArgs: ['/S'] } }),
      { platform: 'darwin', arch: 'arm64' }
    ),
    /silentArgs/
  );
});

test('플랫폼에 맞지 않는 설치 방식은 거절한다', () => {
  assert.throws(
    () => readManifestFields(
      manifest({}, { 'darwin-arm64': { kind: 'nsis' } }),
      { platform: 'darwin', arch: 'arm64' }
    ),
    /설치 방식/
  );
});

test('HTTPS가 아닌 installerUrl은 거절한다', () => {
  assert.throws(
    () => readManifestFields(
      manifest({}, { 'win32-x64': { installerUrl: 'http://example.test/Claw-Ad-Setup-0.1.0-x64.exe' } }),
      { platform: 'win32', arch: 'x64' }
    ),
    /installerUrl/
  );
});

test('제품명을 얻을 수 없는 파일명은 거절한다', () => {
  assert.throws(
    () => readManifestFields(
      manifest({}, { 'win32-x64': { installerUrl: 'https://example.test/download.exe', productName: undefined } }),
      { platform: 'win32', arch: 'x64' }
    ),
    /제품명/
  );
});

test('제품명에 경로 문자가 섞이면 거절한다', () => {
  // 제품명은 설치 경로와 osascript 인수로 들어간다.
  assert.throws(
    () => readManifestFields(
      manifest({}, { 'darwin-arm64': { productName: '../../etc/passwd' } }),
      { platform: 'darwin', arch: 'arm64' }
    ),
    /제품명/
  );
});

test('버전·체크섬 형식을 검증한다', () => {
  const win = { platform: 'win32', arch: 'x64' };
  assert.throws(() => readManifestFields(manifest({ version: 'latest' }), win), /version/);
  assert.throws(() => readManifestFields(manifest({}, { 'win32-x64': { sha256: 'nope' } }), win), /SHA-256/);
  assert.throws(() => readManifestFields(manifest({}, { 'win32-x64': { bytes: 0 } }), win), /bytes/);
});

test('제거는 제거 프로그램이 있을 때만 실행한다', () => {
  const env = emptyLocalAppData();
  const calls = [];
  const spawnSync = (file, args) => { calls.push({ file, args }); return { status: 0 }; };

  const missing = uninstallOverlay({ env, platform: 'win32', spawnSync });
  assert.strictEqual(missing.status, 'skipped');
  assert.strictEqual(calls.length, 0);

  const { dir } = installedPaths('Claw-Ad', env, 'win32');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Uninstall Claw-Ad.exe'), 'uninstaller');

  const removed = uninstallOverlay({ env, platform: 'win32', spawnSync });
  assert.strictEqual(removed.status, 'removed');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, ['/S']);
});

test('macOS 제거는 종료를 요청하고 번들을 지운다', () => {
  const env = emptyHome();
  const calls = [];
  const spawnSync = (file, args) => { calls.push({ file, args }); return { status: 0 }; };

  const missing = uninstallOverlay({ env, platform: 'darwin', spawnSync });
  assert.strictEqual(missing.status, 'skipped');
  assert.strictEqual(calls.length, 0);

  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  fs.mkdirSync(path.join(target, 'Contents'), { recursive: true });

  const removed = uninstallOverlay({ env, platform: 'darwin', spawnSync });
  assert.strictEqual(removed.status, 'removed');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].file, '/usr/bin/osascript');
  assert.ok(!fs.existsSync(target), '앱 번들이 남아 있다');
});

test('제거도 지원하지 않는 플랫폼에서는 아무것도 하지 않는다', () => {
  const result = uninstallOverlay({ platform: 'linux' });
  assert.strictEqual(result.status, 'unsupported');
});
