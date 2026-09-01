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
  readInstallRecord,
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
  // 설치 폴더 **안에** 스테이징한다 — rename이 같은 볼륨에서만 원자적이기 때문이다 (CLAW-160).
  const appsDir = path.join(env.HOME, 'Applications');
  assert.strictEqual(path.dirname(calls[0].args[3]), appsDir);
  assert.match(path.basename(calls[0].args[3]), /^\.Claw-Ad\.staging-/);
  assert.ok(fs.existsSync(path.join(appsDir, 'Claw-Ad.app')));
  // 스테이징 흔적을 남기지 않는다.
  assert.deepStrictEqual(fs.readdirSync(appsDir), ['Claw-Ad.app']);
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

// CLAW-144: 멈춘 인스톨러가 CLI를 무한히 붙잡던 문제. 타임아웃이 없으면 이 테스트가 영원히 끝나지 않는다.
test('멈춘 인스톨러는 타임아웃으로 끊고 한 번만 다시 시도한다 (CLAW-144)', async () => {
  let attempts = 0;
  const timeouts = [];
  const { options } = deps({
    spawnSync: (file, args, opts) => {
      attempts += 1;
      timeouts.push(opts && opts.timeout);
      return { error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
    },
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.stage, 'run');
  assert.match(result.message, /끝나지 않아 중단/);
  assert.match(result.message, /2회/);
  assert.strictEqual(attempts, 2, '재시도는 정확히 한 번이다 — 무한 루프가 되면 CLI 설치를 붙잡는다');
  assert.ok(timeouts.every((value) => value > 0), 'spawnSync에 타임아웃을 넘겨야 멈춘 인스톨러를 끊을 수 있다');
});

test('사용자가 취소한 설치는 다시 시도하지 않는다 (CLAW-144)', async () => {
  let attempts = 0;
  const { options } = deps({ spawnSync: () => { attempts += 1; return { status: 1223 }; } });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  assert.match(result.message, /권한 요청이 취소/);
  assert.match(result.message, /1223/, '해석이 틀렸을 때를 위해 원본 코드를 남긴다');
  assert.strictEqual(attempts, 1, '사용자가 거절한 설치를 되풀이하지 않는다');
});

test('일시적으로 보이는 실패는 다시 시도해 성공할 수 있다 (CLAW-144)', async () => {
  let attempts = 0;
  const { options } = deps({
    // 0xC0000005. CLAW-144에서 1회 관측됐고 재현되지 않았다 — 과도 상태로 보고 한 번 더 본다.
    spawnSync: () => { attempts += 1; return attempts === 1 ? { status: 3221225477 } : { status: 0 }; },
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'installed');
  assert.strictEqual(attempts, 2);
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

// CLAW-160: 브라우저 경유가 격리 속성을 붙여 Gatekeeper에 막히므로 갱신도 CLI가 맡는다.
// allowUpgrade가 켜졌을 때만 기존 설치본을 교체한다 — setup은 예전대로 건너뛴다.

/** Info.plist를 갖춘 가짜 설치본. defaults 스텁이 이 버전을 돌려준다. */
function stageInstalledApp(env, version) {
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  fs.mkdirSync(path.join(target, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(target, 'Contents', 'Info.plist'), 'stub');
  fs.writeFileSync(path.join(target, 'Contents', 'marker-old'), version);
  return target;
}

function macStub(calls, env, installedVersion) {
  return (file, args) => {
    calls.push({ file, args });
    if (file === '/usr/bin/defaults') return { status: 0, stdout: `${installedVersion}\n` };
    if (file === '/usr/bin/ditto') {
      fs.mkdirSync(path.join(args[3], 'Claw-Ad.app', 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(args[3], 'Claw-Ad.app', 'Contents', 'marker-new'), 'new');
    }
    return { status: 0 };
  };
}

test('allowUpgrade면 구 버전을 새 번들로 교체한다 (CLAW-160)', async () => {
  const env = emptyHome();
  stageInstalledApp(env, '0.0.9');
  const calls = [];
  const { options } = deps({
    platform: 'darwin', arch: 'arm64', env, spawnSync: macStub(calls, env, '0.0.9'),
  });

  const result = await installOverlay({ ...options, allowUpgrade: true });

  assert.strictEqual(result.status, 'installed');
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  // 덮어쓰기가 아니라 교체다 — 구 버전에만 있던 파일이 남으면 두 버전이 섞인다.
  assert.ok(fs.existsSync(path.join(target, 'Contents', 'marker-new')));
  assert.ok(!fs.existsSync(path.join(target, 'Contents', 'marker-old')), '구 번들 잔재가 남으면 안 된다');
  assert.deepStrictEqual(fs.readdirSync(path.join(env.HOME, 'Applications')), ['Claw-Ad.app']);
});

test('allowUpgrade여도 버전이 같으면 내려받지 않는다 (CLAW-160)', async () => {
  const env = emptyHome();
  stageInstalledApp(env, '0.1.0');
  const calls = [];
  const { options } = deps({
    platform: 'darwin', arch: 'arm64', env, spawnSync: macStub(calls, env, '0.1.0'),
  });

  const result = await installOverlay({ ...options, allowUpgrade: true });

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.reason, 'up-to-date');
  assert.ok(!calls.some((c) => c.file === '/usr/bin/ditto'), '최신이면 압축을 풀지 않는다');
});

test('교체에 실패하면 구 번들이 제자리에 남는다 (CLAW-160)', async () => {
  const env = emptyHome();
  const target = stageInstalledApp(env, '0.0.9');
  const calls = [];
  const { options } = deps({
    platform: 'darwin', arch: 'arm64', env,
    // ditto가 번들을 만들지 않는다 = 압축은 됐는데 내용이 없는 경우.
    spawnSync: (file, args) => {
      calls.push({ file, args });
      if (file === '/usr/bin/defaults') return { status: 0, stdout: '0.0.9\n' };
      return { status: 0 };
    },
  });

  const result = await installOverlay({ ...options, allowUpgrade: true });

  assert.strictEqual(result.status, 'failed');
  assert.ok(fs.existsSync(path.join(target, 'Contents', 'marker-old')), '구 번들이 사라지면 안 된다');
  assert.deepStrictEqual(fs.readdirSync(path.join(env.HOME, 'Applications')), ['Claw-Ad.app']);
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
  assert.strictEqual(calls[0].file, '/usr/bin/osascript');
  // 종료 확인이 뒤따른다 (CLAW-212) — 살아 있는 앱은 정리를 곧바로 되돌린다.
  assert.strictEqual(calls[1].file, '/usr/bin/pgrep');
  assert.ok(!fs.existsSync(target), '앱 번들이 남아 있다');
});

// 설치는 INSTALLER_TIMEOUT_MS로 끊는데 제거만 빠져 있었다 (CLAW-266). 백신·잠긴 파일로 멈춘
// 언인스톨러(또는 대화상자로 멈춘 앱의 quit 대기)가 uninstall 전체를 무한히 붙잡으면,
// 사용자가 Ctrl+C한 시점에 훅·전역 명령이 남는 반제거 상태가 된다.
test('제거 실행에도 타임아웃을 건다 (CLAW-266)', () => {
  const env = emptyLocalAppData();
  const calls = [];
  const spawnSync = (file, args, options) => { calls.push({ file, args, options }); return { status: 0 }; };
  const { dir } = installedPaths('Claw-Ad', env, 'win32');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Uninstall Claw-Ad.exe'), 'uninstaller');
  uninstallOverlay({ env, platform: 'win32', spawnSync });
  assert.ok(Number.isFinite(calls[0].options && calls[0].options.timeout), 'NSIS 언인스톨러 실행에 타임아웃이 있어야 한다');

  const macEnv = emptyHome();
  const macCalls = [];
  const macSpawn = (file, args, options) => { macCalls.push({ file, args, options }); return { status: 0 }; };
  const { target } = installedPaths('Claw-Ad', macEnv, 'darwin');
  fs.mkdirSync(path.join(target, 'Contents'), { recursive: true });
  uninstallOverlay({ env: macEnv, platform: 'darwin', spawnSync: macSpawn });
  const quit = macCalls.find((call) => call.file === '/usr/bin/osascript');
  assert.ok(quit && Number.isFinite(quit.options && quit.options.timeout), 'quit app 요청에 타임아웃이 있어야 한다');
});

// macOS 제거는 번들을 지우기만 해서 오버레이가 남긴 등록이 통째로 살아남았다. 특히
// statusLine이 지워진 앱 경로를 가리킨 채 남아 Claude Code가 매 렌더 실행했다 (CLAW-212).
function stageCleanupEntry(env) {
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  const dir = path.join(target, 'Contents', 'Resources', 'app.asar.unpacked', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, 'cleanup-integrations.js');
  fs.writeFileSync(entry, '\n');
  return { target, entry };
}

test('macOS 제거가 오버레이 연동 정리를 앱 삭제 전에 실행한다 (CLAW-212)', () => {
  const env = emptyHome();
  const calls = [];
  const { target, entry } = stageCleanupEntry(env);
  const spawnSync = (file, args) => {
    calls.push({ file, args });
    // 정리를 부르는 시점에는 번들이 아직 있어야 한다 — 지운 뒤엔 실행할 파일이 없다.
    if (file === process.execPath) assert.ok(fs.existsSync(target), '삭제 전에 정리해야 한다');
    return { status: 0, stdout: '' };
  };

  const removed = uninstallOverlay({ env, platform: 'darwin', spawnSync });

  assert.deepStrictEqual(removed.integrations, { ok: true });
  const cleanup = calls.find((c) => c.file === process.execPath);
  assert.ok(cleanup, '정리 진입점을 실행해야 한다');
  assert.strictEqual(cleanup.args[0], entry);
  assert.ok(!fs.existsSync(target));
});

test('정리에 실패해도 앱 번들은 지운다 (CLAW-212)', () => {
  const env = emptyHome();
  const { target } = stageCleanupEntry(env);
  const spawnSync = (file) => (file === process.execPath
    ? { status: 1, stderr: '권한 없음' }
    : { status: 0, stdout: '' });

  const removed = uninstallOverlay({ env, platform: 'darwin', spawnSync });

  assert.strictEqual(removed.status, 'removed');
  assert.strictEqual(removed.integrations.ok, false);
  assert.match(removed.integrations.message, /권한 없음/);
  assert.ok(!fs.existsSync(target), '정리 실패로 번들을 남기면 사용자가 앱도 등록도 못 지운다');
});

test('앱이 꺼질 때까지 기다린 뒤 정리한다 (CLAW-212)', () => {
  const env = emptyHome();
  stageCleanupEntry(env);
  const order = [];
  let alive = 2;
  const spawnSync = (file) => {
    order.push(file);
    if (file === '/usr/bin/pgrep') return { status: 0, stdout: alive-- > 0 ? '4242\n' : '' };
    return { status: 0, stdout: '' };
  };

  uninstallOverlay({ env, platform: 'darwin', spawnSync });

  const cleanupAt = order.indexOf(process.execPath);
  const lastProbeAt = order.lastIndexOf('/usr/bin/pgrep');
  assert.ok(lastProbeAt < cleanupAt, '살아 있는 동안은 정리하지 않는다');
  assert.ok(order.includes('/bin/sleep'), '다시 확인하기 전에 기다린다');
});

test('제거도 지원하지 않는 플랫폼에서는 아무것도 하지 않는다', () => {
  const result = uninstallOverlay({ platform: 'linux' });
  assert.strictEqual(result.status, 'unsupported');
});

// ── 경량 업데이트 (CLAW-161) ────────────────────────────────────────────
//
// 앱 358MB 중 우리 코드는 app.asar 6.8MB뿐이다. Electron·의존성이 그대로면 그것만 갈면 된다.
// **잘못 판단하면 다른 Electron 위에 우리 코드가 얹혀 앱이 안 켜진다** — 모르면 전체 교체가
// 안전한 기본값이라는 성질을 여기서 못 박는다.

const ASAR = Buffer.from('asar payload v2');
const ASAR_DIGEST = crypto.createHash('sha256').update(ASAR).digest('hex');
const RUNTIME_ID = 'b'.repeat(64);
// asar 밖 트리 묶음 (CLAW-283). 실제 tar는 mock이 흉내 낸다 — 여기서 못 박는 것은 압축
// 해제가 아니라 검증·교체·되돌리기다.
const UNPACKED = Buffer.from('unpacked payload v2');
const UNPACKED_DIGEST = crypto.createHash('sha256').update(UNPACKED).digest('hex');
const UNPACKED_URL = `${RELEASE}/app-0.1.0-arm64.unpacked.tar.gz`;

function codeUpdateEntry(overrides = {}) {
  return {
    url: `${RELEASE}/app-0.1.0-arm64.asar`,
    sha256: ASAR_DIGEST,
    bytes: ASAR.length,
    unpacked: { url: UNPACKED_URL, sha256: UNPACKED_DIGEST, bytes: UNPACKED.length },
    ...overrides,
  };
}

function asarManifest(overrides = {}) {
  return {
    ...manifest(),
    runtimeId: RUNTIME_ID,
    codeUpdate: { 'darwin-arm64': codeUpdateEntry() },
    ...overrides,
  };
}

/** app.asar와 asar 밖 트리까지 갖춘 가짜 설치본. */
function stageAppWithAsar(env, version, asarBody) {
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  const resources = path.join(target, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(target, 'Contents', 'Info.plist'), 'stub');
  fs.writeFileSync(path.join(resources, 'app.asar'), asarBody);
  const themes = path.join(resources, 'app.asar.unpacked', 'themes', 'clawad', 'assets');
  fs.mkdirSync(themes, { recursive: true });
  fs.writeFileSync(path.join(themes, 'p-body-face.png'), 'old theme');
  // 네이티브 트리는 경량 경로가 건드리면 안 되는 영역이다 — runtimeId 관할.
  const native = path.join(resources, 'app.asar.unpacked', 'node_modules', 'koffi');
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, 'koffi.node'), 'native');
  return path.join(resources, 'app.asar');
}

function unpackedPath(env, ...parts) {
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  return path.join(target, 'Contents', 'Resources', 'app.asar.unpacked', ...parts);
}

function themeFile(env) {
  return unpackedPath(env, 'themes', 'clawad', 'assets', 'p-body-face.png');
}

function writeRecord(env, runtimeId, hashes = {}) {
  const { dir } = installedPaths('Claw-Ad', env, 'darwin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.Claw-Ad.install.json'),
    JSON.stringify({ version: 1, appVersion: '0.0.9', runtimeId, ...hashes }));
}

function asarDeps(env, {
  record = RUNTIME_ID, manifestValue, tarFails = false, dittoFails = false,
  tarEntry = ['themes', 'clawad', 'assets'], hashes = {}, installedVersion = '0.0.9',
} = {}) {
  const calls = [];
  if (record) writeRecord(env, record, hashes);
  return {
    calls,
    options: {
      manifestUrl: 'https://example.test/overlay-manifest.json',
      platform: 'darwin',
      arch: 'arm64',
      env,
      allowUpgrade: true,
      fetchManifest: async () => readManifestFields(manifestValue || asarManifest(), { platform: 'darwin', arch: 'arm64' }),
      download: async (url) => {
        calls.push({ download: url });
        if (url.endsWith('.unpacked.tar.gz')) return UNPACKED;
        return url.endsWith('.asar') ? ASAR : INSTALLER;
      },
      spawnSync: (file, args, opts) => {
        calls.push({ file, args });
        if (file === '/usr/bin/defaults') return { status: 0, stdout: `${installedVersion}\n` };
        if (file === '/usr/bin/ditto') {
          if (dittoFails) return { status: 1, stderr: 'ditto: refused' };
          fs.mkdirSync(path.join(args[3], 'Claw-Ad.app', 'Contents', 'Resources'), { recursive: true });
          fs.writeFileSync(path.join(args[3], 'Claw-Ad.app', 'Contents', 'Resources', 'app.asar'), 'full');
        }
        // tar 대역. 묶음에 담기는 것과 같은 구성을 stage에 만든다.
        if (file === '/usr/bin/tar') {
          if (tarFails) return { status: 1, stderr: 'tar: broken archive' };
          const dir = path.join(opts.cwd, ...tarEntry);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'p-body-face.png'), 'new theme');
        }
        return { status: 0 };
      },
    },
  };
}

test('runtimeId가 같으면 app.asar만 갈아끼운다 (CLAW-161)', async () => {
  const env = emptyHome();
  const asarPath = stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { calls, options } = asarDeps(env);

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'installed');
  assert.strictEqual(result.mode, 'code-only');
  assert.strictEqual(fs.readFileSync(asarPath, 'utf8'), 'asar payload v2');
  // 123MB zip을 받지 않았는지 — 이 최적화의 전부다. asar 밖 트리 묶음은 0.6MB라 함께 받는다.
  assert.deepStrictEqual(calls.filter((c) => c.download).map((c) => c.download),
    [`${RELEASE}/app-0.1.0-arm64.asar`, UNPACKED_URL]);
  assert.ok(!calls.some((c) => c.file === '/usr/bin/ditto'), '경량 경로는 압축을 풀지 않는다');
});

// ── asar 밖 트리 (CLAW-283) ─────────────────────────────────────────────
//
// 번들 테마는 asarUnpack 대상이라 app.asar 밖에 있다. asar만 갈면 테마 변경이 사용자에게
// 닿지 않는다 — 0.2.12가 그렇게 나갔다. 경량 경로가 그 트리까지 책임진다.

test('경량 경로가 asar 밖 트리도 갈아끼운다 (CLAW-283)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { calls, options } = asarDeps(env);

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'code-only');
  assert.strictEqual(fs.readFileSync(themeFile(env), 'utf8'), 'new theme');
  assert.ok(calls.some((c) => c.file === '/usr/bin/tar'), '묶음을 풀었다');
  // 87MB 네이티브 트리는 건드리지 않는다 — 그쪽 판정은 runtimeId가 한다.
  assert.strictEqual(fs.readFileSync(unpackedPath(env, 'node_modules', 'koffi', 'koffi.node'), 'utf8'), 'native');
});

test('unpacked 블록이 없으면 경량 경로를 타지 않는다 (CLAW-283)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const legacy = asarManifest({
    codeUpdate: { 'darwin-arm64': { url: `${RELEASE}/app-0.1.0-arm64.asar`, sha256: ASAR_DIGEST, bytes: ASAR.length } },
  });
  const { calls, options } = asarDeps(env, { manifestValue: legacy });

  const result = await installOverlay(options);

  // 구 매니페스트는 asar 밖 트리를 실어 보내지 않는다. 반쪽만 갈 바에 전체 교체가 맞다.
  assert.strictEqual(result.mode, 'full');
  assert.ok(calls.some((c) => c.file === '/usr/bin/ditto'));
});

test('unpacked 체크섬이 다르면 asar도 갈지 않고 전체 교체로 내려간다 (CLAW-283)', async () => {
  const env = emptyHome();
  const asarPath = stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const bad = asarManifest({
    codeUpdate: {
      'darwin-arm64': codeUpdateEntry({
        unpacked: { url: UNPACKED_URL, sha256: 'e'.repeat(64), bytes: UNPACKED.length },
      }),
    },
  });
  const { calls, options } = asarDeps(env, { manifestValue: bad });

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'full');
  // 검증은 둘 다 끝난 뒤에 손을 댄다 — 짝이 어긋난 설치본을 남기지 않는다.
  assert.notStrictEqual(fs.readFileSync(asarPath, 'utf8'), 'asar payload v2');
  assert.ok(calls.some((c) => c.file === '/usr/bin/ditto'));
});

test('묶음을 풀지 못하면 전체 교체로 내려간다 (CLAW-283)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { calls, options } = asarDeps(env, { tarFails: true });

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'full');
  assert.ok(calls.some((c) => c.file === '/usr/bin/ditto'));
});

test('묶음에 node_modules가 있으면 거부하고 전체 교체로 내려간다 (CLAW-283)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { calls, options } = asarDeps(env, { tarEntry: ['node_modules', 'koffi'] });

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'full');
  assert.ok(calls.some((c) => c.file === '/usr/bin/ditto'));
});

test('node_modules를 거부할 때 네이티브 트리를 건드리지 않는다 (CLAW-283)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  // 전체 교체까지 막아 세워 경량 경로가 남긴 상태를 그대로 본다 — 성공하면 번들을 통째로
  // 다시 만들어 버려서 무엇을 건드렸는지 알 수 없다.
  const { options } = asarDeps(env, { tarEntry: ['node_modules', 'koffi'], dittoFails: true });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'failed');
  // 87MB 네이티브 트리를 반쪽으로 덮으면 앱이 켜지지 않는다. 이름을 보고 물러서야 한다.
  assert.strictEqual(fs.readFileSync(unpackedPath(env, 'node_modules', 'koffi', 'koffi.node'), 'utf8'), 'native');
  assert.strictEqual(fs.readFileSync(themeFile(env), 'utf8'), 'old theme');
  const leftovers = fs.readdirSync(unpackedPath(env)).filter((name) => name.includes('.old-') || name.startsWith('.clawad-'));
  assert.deepStrictEqual(leftovers, [], '중간 산출물을 남기지 않는다');
});

test('codeUpdate.unpacked 형식이 어긋나면 통째로 버린다 (CLAW-283)', () => {
  const bad = [
    undefined,
    { url: 'http://insecure.test/app.unpacked.tar.gz', sha256: UNPACKED_DIGEST, bytes: 3 },
    { url: `${RELEASE}/app.zip`, sha256: UNPACKED_DIGEST, bytes: 3 },
    { url: UNPACKED_URL, sha256: 'nope', bytes: 3 },
    { url: UNPACKED_URL, sha256: UNPACKED_DIGEST, bytes: 0 },
  ];
  for (const unpacked of bad) {
    const value = asarManifest({ codeUpdate: { 'darwin-arm64': codeUpdateEntry({ unpacked }) } });
    const fields = readManifestFields(value, { platform: 'darwin', arch: 'arm64' });
    assert.strictEqual(fields.codeUpdate, null, JSON.stringify(unpacked));
  }
});

// ── 조각 단위 갱신 (CLAW-284) ───────────────────────────────────────────
//
// 무엇이 바뀌었는지는 조각 해시가 말한다. 버전 숫자로 판정하면 (1) 테마만 바뀐 릴리스에서도
// asar 7.17MB를 같이 받고, (2) 반쪽만 갱신된 설치본이 스스로 최신이라 우겨 영영 못 고친다.

function downloads(calls) {
  return calls.filter((c) => c.download).map((c) => c.download);
}

test('테마만 바뀌면 asar를 받지 않는다 (CLAW-284)', async () => {
  const env = emptyHome();
  const asarPath = stageAppWithAsar(env, '0.0.9', 'asar payload v2');
  // asar는 매니페스트와 같고 묶음만 다르다 — 테마만 손본 릴리스의 모양이다.
  const { calls, options } = asarDeps(env, {
    hashes: { asarSha256: ASAR_DIGEST, unpackedSha256: 'f'.repeat(64) },
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'code-only');
  assert.deepStrictEqual(downloads(calls), [UNPACKED_URL], 'asar는 받지 않는다');
  assert.strictEqual(fs.readFileSync(themeFile(env), 'utf8'), 'new theme');
  assert.strictEqual(fs.readFileSync(asarPath, 'utf8'), 'asar payload v2', 'asar는 건드리지 않는다');
  // 다음 갱신을 위해 두 해시가 모두 매니페스트를 가리켜야 한다.
  const record = readInstallRecord('Claw-Ad', env, 'darwin');
  assert.strictEqual(record.unpackedSha256, UNPACKED_DIGEST);
  assert.strictEqual(record.asarSha256, ASAR_DIGEST);
});

test('코드만 바뀌면 묶음을 받지 않는다 (CLAW-284)', async () => {
  const env = emptyHome();
  const asarPath = stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { calls, options } = asarDeps(env, {
    hashes: { asarSha256: 'f'.repeat(64), unpackedSha256: UNPACKED_DIGEST },
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'code-only');
  assert.deepStrictEqual(downloads(calls), [`${RELEASE}/app-0.1.0-arm64.asar`], '묶음은 받지 않는다');
  assert.strictEqual(fs.readFileSync(asarPath, 'utf8'), 'asar payload v2');
  assert.strictEqual(fs.readFileSync(themeFile(env), 'utf8'), 'old theme', '테마는 건드리지 않는다');
  assert.ok(!calls.some((c) => c.file === '/usr/bin/tar'), '묶음을 풀지 않는다');
});

test('두 조각이 모두 같으면 버전을 보지 않고도 최신으로 끝낸다 (CLAW-284)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v2');
  // 번들 버전 표기는 낡았지만(0.0.9) 조각은 둘 다 매니페스트와 같다. 받을 것이 없다.
  const { calls, options } = asarDeps(env, {
    hashes: { asarSha256: ASAR_DIGEST, unpackedSha256: UNPACKED_DIGEST },
  });

  const result = await installOverlay(options);

  assert.strictEqual(result.reason, 'up-to-date');
  assert.deepStrictEqual(downloads(calls), [], '아무것도 받지 않는다');
});

test('해시 없는 구 기록은 버전이 같아도 두 조각을 다시 맞춘다 (CLAW-284)', async () => {
  const env = emptyHome();
  // 0.2.13까지의 경량 갱신이 남긴 상태 그대로: 번들 버전은 최신(0.1.0)이라고 말하는데
  // asar 밖 트리는 옛것이고, 기록에는 조각 해시가 없다. 여기서 자기 치유가 되어야 한다.
  const asarPath = stageAppWithAsar(env, '0.1.0', 'asar payload v2');
  const { calls, options } = asarDeps(env, { installedVersion: '0.1.0' });

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'code-only');
  assert.deepStrictEqual(downloads(calls), [`${RELEASE}/app-0.1.0-arm64.asar`, UNPACKED_URL]);
  assert.strictEqual(fs.readFileSync(themeFile(env), 'utf8'), 'new theme', '낡은 테마를 고쳤다');
  assert.strictEqual(fs.readFileSync(asarPath, 'utf8'), 'asar payload v2');
  // 한 번 고친 뒤에는 다시 받지 않는다 — 복구가 매번 반복되면 그것도 버그다.
  const again = asarDeps(env, { record: null, installedVersion: '0.1.0' });
  assert.strictEqual((await installOverlay(again.options)).reason, 'up-to-date');
  assert.deepStrictEqual(downloads(again.calls), []);
});

test('설치 기록이 없으면 전체 교체한다 — 모르는 상태에서 갈지 않는다 (CLAW-161)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { calls, options } = asarDeps(env, { record: null });

  const result = await installOverlay(options);

  assert.strictEqual(result.status, 'installed');
  assert.strictEqual(result.mode, 'full');
  assert.ok(calls.some((c) => c.file === '/usr/bin/ditto'));
});

test('runtimeId가 다르면 전체 교체한다 — Electron·의존성이 바뀐 경우 (CLAW-161)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { calls, options } = asarDeps(env, { record: 'c'.repeat(64) });

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'full');
  assert.ok(calls.some((c) => c.file === '/usr/bin/ditto'));
});

test('asar 체크섬이 다르면 갈지 않고 전체 교체로 내려간다 (CLAW-161)', async () => {
  const env = emptyHome();
  const asarPath = stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const bad = asarManifest({
    codeUpdate: { 'darwin-arm64': { url: `${RELEASE}/app-0.1.0-arm64.asar`, sha256: 'd'.repeat(64), bytes: ASAR.length } },
  });
  const { calls, options } = asarDeps(env, { manifestValue: bad });

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'full', '검증 실패는 갱신 포기가 아니라 전체 교체다');
  assert.ok(calls.some((c) => c.file === '/usr/bin/ditto'));
  assert.notStrictEqual(fs.readFileSync(asarPath, 'utf8'), 'asar payload v2');
});

test('codeUpdate 형식이 어긋나면 통째로 버린다 (CLAW-161)', async () => {
  const bad = [
    { 'darwin-arm64': { url: 'http://insecure.test/app.asar', sha256: ASAR_DIGEST, bytes: 3 } },
    { 'darwin-arm64': { url: `${RELEASE}/app.zip`, sha256: ASAR_DIGEST, bytes: 3 } },
    { 'darwin-arm64': { url: `${RELEASE}/app.asar`, sha256: 'nope', bytes: 3 } },
    { 'darwin-arm64': { url: `${RELEASE}/app.asar`, sha256: ASAR_DIGEST, bytes: 0 } },
  ];
  for (const codeUpdate of bad) {
    const fields = readManifestFields(asarManifest({ codeUpdate }), { platform: 'darwin', arch: 'arm64' });
    assert.strictEqual(fields.codeUpdate, null, JSON.stringify(codeUpdate));
  }
});

test('전체 설치도 설치 기록을 남긴다 — 다음 갱신이 경량으로 갈 수 있게 (CLAW-161)', async () => {
  const env = emptyHome();
  const { options } = asarDeps(env, { record: null });

  await installOverlay({ ...options, allowUpgrade: false });

  const record = readInstallRecord('Claw-Ad', env, 'darwin');
  assert.strictEqual(record.runtimeId, RUNTIME_ID);
  assert.strictEqual(record.appVersion, '0.1.0');
});

test('이미 최신이면 내려받지 않아도 설치 기록을 남긴다 (CLAW-161)', async () => {
  const env = emptyHome();
  // 설치본이 매니페스트와 같은 버전(0.1.0)인데 기록이 없는 상태 — 손으로 깔았거나 구 CLI가 깔았다.
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  fs.mkdirSync(path.join(target, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(target, 'Contents', 'Info.plist'), 'stub');
  const calls = [];
  const options = {
    manifestUrl: 'https://example.test/overlay-manifest.json',
    platform: 'darwin', arch: 'arm64', env, allowUpgrade: true,
    fetchManifest: async () => readManifestFields(asarManifest(), { platform: 'darwin', arch: 'arm64' }),
    download: async () => { calls.push('download'); return ASAR; },
    spawnSync: (file) => {
      calls.push(file);
      // 설치본 버전이 매니페스트와 같다.
      return file === '/usr/bin/defaults' ? { status: 0, stdout: '0.1.0\n' } : { status: 0 };
    },
  };

  const result = await installOverlay(options);

  assert.strictEqual(result.reason, 'up-to-date');
  assert.ok(!calls.includes('download'), '최신이면 내려받지 않는다');
  // 기록이 없으면 다음 갱신이 영영 전체 교체가 된다.
  const record = readInstallRecord('Claw-Ad', env, 'darwin');
  assert.strictEqual(record.runtimeId, RUNTIME_ID);
  assert.strictEqual(record.appVersion, '0.1.0');
});

test('setup 경로(allowUpgrade 없음)도 같은 버전이면 기록을 남긴다 (CLAW-161)', async () => {
  const env = emptyHome();
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  fs.mkdirSync(path.join(target, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(target, 'Contents', 'Info.plist'), 'stub');
  const options = {
    manifestUrl: 'https://example.test/overlay-manifest.json',
    platform: 'darwin', arch: 'arm64', env,
    fetchManifest: async () => readManifestFields(asarManifest(), { platform: 'darwin', arch: 'arm64' }),
    download: async () => ASAR,
    spawnSync: (file) => (file === '/usr/bin/defaults' ? { status: 0, stdout: '0.1.0\n' } : { status: 0 }),
  };

  const result = await installOverlay(options);

  assert.strictEqual(result.reason, 'already-installed');
  assert.strictEqual(readInstallRecord('Claw-Ad', env, 'darwin').runtimeId, RUNTIME_ID);
});

test('설치본 버전이 다르면 기록을 남기지 않는다 — 어떤 런타임인지 모른다 (CLAW-161)', async () => {
  const env = emptyHome();
  const { target } = installedPaths('Claw-Ad', env, 'darwin');
  fs.mkdirSync(path.join(target, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(target, 'Contents', 'Info.plist'), 'stub');
  const options = {
    manifestUrl: 'https://example.test/overlay-manifest.json',
    platform: 'darwin', arch: 'arm64', env,
    fetchManifest: async () => readManifestFields(asarManifest(), { platform: 'darwin', arch: 'arm64' }),
    download: async () => ASAR,
    spawnSync: (file) => (file === '/usr/bin/defaults' ? { status: 0, stdout: '0.0.9\n' } : { status: 0 }),
  };

  await installOverlay(options);

  assert.strictEqual(readInstallRecord('Claw-Ad', env, 'darwin'), null,
    '0.0.9가 어떤 Electron 위에 있는지 모른다 — 추측해서 기록하면 안 된다');
});

// 110MB 다운로드가 멈춘 것처럼 보인다는 알파 테스터 제보. 터미널에서는 게이지 한 줄을
// 덮어쓰고, 파이프·CI에서는 20% 단위 줄만 남긴다 — 로그가 조각으로 뭉치지 않게.
const { downloadProgress } = require('../client/overlay-install');
const TOTAL_MB = 110 * 1024 * 1024;

function drive(report, total, steps = 40) {
  for (let i = 1; i <= steps; i += 1) report(Math.round((total / steps) * i), total);
  report.done();
}

test('터미널에서는 게이지를 한 줄에 덮어쓴다', () => {
  const frames = [];
  const out = { isTTY: true, write: (s) => frames.push(s) };
  drive(downloadProgress(() => { throw new Error('TTY에서는 log를 쓰지 않는다'); }, 20, out), TOTAL_MB);

  const painted = frames.filter((f) => f !== '\n');
  assert.ok(painted.length > 5, '게이지는 자주 갱신돼야 한다');
  for (const frame of painted) assert.ok(frame.startsWith('\r'), '같은 줄을 덮어써야 한다');
  const last = painted[painted.length - 1];
  assert.match(last, /\[█{24}\] 100%\s+110 \/ 110 MB/, '완료 프레임이 가득 차야 한다');
  assert.strictEqual(frames[frames.length - 1], '\n', '끝나면 줄을 닫아야 한다');
});

test('파이프·CI에서는 20% 단위 줄만 남긴다', () => {
  const lines = [];
  drive(downloadProgress((l) => lines.push(l), 20, { isTTY: false }), TOTAL_MB);
  assert.deepStrictEqual(lines.map((l) => l.trim()), [
    '20% (22 / 110 MB)', '40% (44 / 110 MB)', '60% (66 / 110 MB)', '80% (88 / 110 MB)', '100% (110 / 110 MB)',
  ]);
});

// 중간에 실패하면 게이지 줄이 열린 채 남아 오류 메시지가 같은 줄에 붙는다.
test('중간에 끊겨도 게이지 줄을 닫는다', () => {
  const frames = [];
  const out = { isTTY: true, write: (s) => frames.push(s) };
  const report = downloadProgress(() => {}, 20, out);
  report(TOTAL_MB / 3, TOTAL_MB);
  assert.notStrictEqual(frames[frames.length - 1], '\n', '아직 진행 중이면 줄이 열려 있다');
  report.done();
  assert.strictEqual(frames[frames.length - 1], '\n', 'done()이 줄을 닫아야 한다');
  report.done();
  assert.strictEqual(frames.filter((f) => f === '\n').length, 1, 'done()을 두 번 불러도 한 번만 닫는다');
});

test('content-length가 없으면 받은 양만 알린다', () => {
  const lines = [];
  const report = downloadProgress((l) => lines.push(l), 20, { isTTY: false });
  for (let received = 0; received <= 45 * 1024 * 1024; received += 4 * 1024 * 1024) report(received, 0);
  assert.ok(lines.length >= 3, '받은 양을 주기적으로 알려야 한다');
  for (const line of lines) assert.match(line, /MB 받았습니다…$/);
  assert.ok(!lines.some((l) => l.includes('%')), '전체 크기를 모르면 비율을 만들어내면 안 된다');
});

// 경량 갱신은 app.asar만 갈지만, 설치 버전 판단(readInstalledVersion)은 번들의 Info.plist를
// 읽는다. 그걸 안 고치면 갱신이 끝나도 CLI는 옛 버전이 깔려 있다고 보고 매번 다시 내려받고,
// macOS Electron의 app.getVersion()도 옛 번호를 말해 화면에 남는다 (CLAW-216).
test('경량 갱신이 번들 버전 표기까지 고친다 (CLAW-216)', async () => {
  const env = emptyHome();
  stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { calls, options } = asarDeps(env);

  const result = await installOverlay(options);

  assert.strictEqual(result.mode, 'code-only');
  const stamped = calls.filter((c) => c.file === '/usr/bin/plutil');
  assert.deepStrictEqual(stamped.map((c) => c.args[1]), ['CFBundleShortVersionString', 'CFBundleVersion']);
  for (const call of stamped) {
    assert.strictEqual(call.args[0], '-replace');
    assert.strictEqual(call.args[3], '0.1.0', '매니페스트 버전으로 고쳐야 한다');
    assert.ok(call.args[4].endsWith(path.join('Claw-Ad.app', 'Contents', 'Info.plist')), `번들 Info.plist를 가리켜야 한다: ${call.args[4]}`);
  }
});

// asar는 이미 새것이라 앱은 새 코드로 돈다. 표기 실패로 갱신 전체를 실패시키면 더 나쁘다.
test('버전 표기 실패는 갱신을 실패시키지 않고 알리기만 한다 (CLAW-216)', async () => {
  const env = emptyHome();
  const asarPath = stageAppWithAsar(env, '0.0.9', 'asar payload v1');
  const { options } = asarDeps(env);
  const lines = [];
  const result = await installOverlay({
    ...options,
    log: (line) => lines.push(line),
    stampBundleVersion: () => ({ ok: false, message: '권한 없음' }),
  });

  assert.strictEqual(result.status, 'installed');
  assert.strictEqual(fs.readFileSync(asarPath, 'utf8'), 'asar payload v2', 'asar 교체는 그대로 유효하다');
  assert.ok(lines.some((l) => /번들 버전 표기를 고치지 못해/.test(l)), '조용히 넘기지 않는다');
});
