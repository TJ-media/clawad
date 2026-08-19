'use strict';

// 릴리스 URL은 package.json 버전에서 파생시킨다. 버전 상향 때마다 테스트가 깨지는 회귀를 막는다.
const RELEASE_VERSION = require('../package.json').version;
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256, validateManifest } = require('../client/release');

test('릴리스 manifest는 HTTPS 패키지와 SHA-256만 허용한다', () => {
  const bytes = Buffer.from('clawad-release');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.deepStrictEqual(validateManifest({
    version: '1.2.3',
    packageUrl: 'https://github.com/TJ-media/clawad/releases/download/v1.2.3/clawad.tgz',
    sha256: digest,
  }), {
    version: '1.2.3',
    packageUrl: 'https://github.com/TJ-media/clawad/releases/download/v1.2.3/clawad.tgz',
    sha256: digest,
  });
  assert.strictEqual(sha256(bytes), digest);
  assert.throws(() => validateManifest({ version: '1.2.3', packageUrl: 'http://example.com/clawad.tgz', sha256: digest }), /HTTPS/);
  assert.throws(() => validateManifest({ version: 'latest', packageUrl: 'https://example.com/clawad.tgz', sha256: digest }), /version/);
  assert.throws(() => validateManifest({ version: '1.2.3', packageUrl: 'https://example.com/clawad.tgz', sha256: 'bad' }), /SHA-256/);
});

test('릴리스 빌드는 .tgz가 아닌 packageUrl을 거부한다', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-client-release.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAWAD_RELEASE_API_ORIGIN: 'https://api.clawad.test',
      CLAWAD_RELEASE_WEB_ORIGIN: 'https://clawad.test',
      CLAWAD_RELEASE_MANIFEST_URL: 'https://github.com/TJ-media/clawad/releases/latest/download/manifest.json',
      CLAWAD_RELEASE_PACKAGE_URL: `https://github.com/TJ-media/clawad/releases/download/v${RELEASE_VERSION}/`,
    },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /\.tgz/);
});

test('클라이언트 배포물은 런타임 파일만 포함하고 운영 설정을 고정한다', () => {
  const env = {
    ...process.env,
    CLAWAD_RELEASE_API_ORIGIN: 'https://api.clawad.test',
    CLAWAD_RELEASE_WEB_ORIGIN: 'https://clawad.test',
    CLAWAD_RELEASE_MANIFEST_URL: 'https://github.com/TJ-media/clawad/releases/latest/download/manifest.json',
    CLAWAD_RELEASE_PACKAGE_URL: `https://github.com/TJ-media/clawad/releases/download/v${RELEASE_VERSION}/clawad-cli.tgz`,
  };
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-client-release.js')], { env, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const stage = path.join(__dirname, '..', 'dist', 'client-release', 'package');
  const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(stage, 'distribution.json'), 'utf8'));
  assert.deepStrictEqual(pkg.files, ['client', 'policy', 'distribution.json', 'README.md', 'LICENSE']);
  assert.strictEqual(pkg.license, 'SEE LICENSE IN LICENSE');
  // 배포물에는 실행을 허가하는 클라이언트 라이선스가 들어가야 한다. 저장소 LICENSE는
  // 열람 전용이라 실행·설치를 금지하므로 실행용 패키지에 실을 수 없다 (CLAW-145).
  assert.strictEqual(
    fs.readFileSync(path.join(stage, 'LICENSE'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'LICENSE-CLIENT'), 'utf8'),
  );
  assert.match(fs.readFileSync(path.join(stage, 'LICENSE'), 'utf8'), /permission to install,\s*\n?execute, and use/);
  assert.strictEqual(pkg.engines.node, '>=24');
  // 스코프 패키지는 기본 restricted다. 이 값이 빠지면 게시 명령의 --access 플래그에만 의존하게 되고,
  // 한 번 비공개로 올라가면 restricted 스코프는 유료 플랜을 요구한다 (CLAW-145).
  assert.strictEqual(pkg.publishConfig.access, 'public');
  assert.strictEqual(config.apiOrigin, 'https://api.clawad.test');
  assert.strictEqual(config.webOrigin, 'https://clawad.test', '로그인 위임 대상 웹 origin을 배포 설정에 고정한다.');
  assert.strictEqual(config.packageUrl, `https://github.com/TJ-media/clawad/releases/download/v${RELEASE_VERSION}/clawad-cli.tgz`);
  // 설치·안내 스펙은 레지스트리 경로여야 한다 (CLAW-145). packageUrl은 update의 SHA-256 대조용으로 남는다.
  assert.strictEqual(config.packageSpec, `@clawad/cli@${RELEASE_VERSION}`);
  assert.ok(!fs.existsSync(path.join(stage, 'server')));
  assert.ok(!fs.existsSync(path.join(stage, 'apps')));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'dist', 'client-release', 'manifest.json'), 'utf8'), /"sha256": "[a-f0-9]{64}"/);

  assert.ok(fs.existsSync(path.join(__dirname, '..', 'dist', 'client-release', 'clawad-cli.tgz')),
    '업로드할 tarball은 packageUrl의 파일명으로 만들어져야 한다.');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'client-release', 'manifest.json'), 'utf8'));
  assert.strictEqual(path.basename(new URL(manifest.packageUrl).pathname), 'clawad-cli.tgz');
  assert.strictEqual(
    manifest.sha256,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'dist', 'client-release', 'clawad-cli.tgz'))).digest('hex'),
  );

  // 배포물은 statusLine 광고 서피스를 담지 않는다 (CLAW-134).
  for (const removed of ['statusline.js', 'statusline-wrapper.js', 'statusline-command.js']) {
    assert.ok(!fs.existsSync(path.join(stage, 'client', removed)), `배포물에 ${removed}이 있으면 안 된다`);
  }

  // 배포 설치에는 저장소가 없으므로 저장소 전용 npm 스크립트를 안내하면 사용자가 따라할 수 없다.
  const statusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-login-hint-'));
  const syncFailure = spawnSync(process.execPath, [path.join(stage, 'client', 'sync.js')], {
    encoding: 'utf8', env: { ...process.env, CLAWAD_DATA: statusHome },
  });
  assert.doesNotMatch(`${syncFailure.stdout}${syncFailure.stderr}`, /npm run clawad:login/);
  assert.ok(`${syncFailure.stdout}${syncFailure.stderr}`.includes(
    `npx --yes @clawad/cli@${RELEASE_VERSION} login`,
  ), '로그인 안내는 현재 버전의 고정 레지스트리 스펙이어야 합니다.');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-distribution-'));
  const data = path.join(home, 'data');
  const settings = path.join(home, 'settings.json');
  const fakeNpmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-registry-'));
  const fakeNpmCli = path.join(fakeNpmDir, 'npm-cli.js');
  fs.writeFileSync(fakeNpmCli, "process.stdout.write('\\\"999.0.0\\\"\\n');\n");
  fs.writeFileSync(settings, '{}');
  const setup = spawnSync(process.execPath, [path.join(stage, 'client', 'setup.js'), 'invalid-provider'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAWAD_DATA: data,
      CLAWAD_SETTINGS: settings,
      CLAWAD_PLATFORM: 'linux',
      CLAWAD_SCHEDULER_DRY_RUN: '1',
      CLAWAD_INITIAL_SYNC_DRY_RUN: '1',
      // 테스트가 개발자·CI의 전역 npm 환경을 바꾸지 않게 한다 (CLAW-103).
      CLAWAD_GLOBAL_CLI_DRY_RUN: '1',
      npm_execpath: fakeNpmCli,
    },
  });
  assert.strictEqual(setup.status, 1);
  // 배포 설치에는 저장소가 없다. 안내 명령은 그대로 실행 가능한 npx 형태여야 한다.
  assert.doesNotMatch(setup.stdout, /node client\/install\.js/, '배포 설치 안내에 저장소 전용 경로를 쓰지 않는다.');
  // 이 설치가 전역 명령을 넣으므로 고지는 짧은 형태를 약속한다 (CLAW-223). 버전 고정 npx 스펙은
  // 위 로그인 안내 단언이 계속 지킨다 — 전역 명령이 없는 경로의 대비책이다.
  assert.match(setup.stdout, /제거: clawad uninstall/);
  assert.match(setup.stderr, new RegExp(`${RELEASE_VERSION}.*999\\.0\\.0`, 's'),
    'setup 마지막에 현재 버전과 npm latest가 어긋난 사실을 경고해야 한다 (CLAW-237)');
  // 활동 감지 훅만 등록하고 statusLine 슬롯은 비워 둔다 (CLAW-134).
  const installedSettings = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(!('statusLine' in installedSettings), 'clawad는 statusLine 슬롯을 점유하지 않는다');
  const hookCommands = Object.values(installedSettings.hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(hookCommands.some((command) => command.includes(path.join('releases', RELEASE_VERSION, 'package', 'client', 'work-activity.js'))),
    `고정된 릴리스 경로의 훅이 등록돼야 한다: ${hookCommands.join(' | ')}`);
  assert.ok(fs.existsSync(path.join(data, 'releases', RELEASE_VERSION, 'package', 'client', 'overlay-events.js')));
  const releaseState = JSON.parse(fs.readFileSync(path.join(data, 'release-state.json'), 'utf8'));
  assert.strictEqual(releaseState.version, RELEASE_VERSION);
  assert.ok(releaseState.root.includes(path.join('releases', RELEASE_VERSION, 'package')));
});

// 110MB를 한 번의 await로 받으면 터미널이 몇 분간 멈춘 것처럼 보인다는 알파 테스터 제보.
// 진행 콜백을 주면 본문을 스트리밍으로 읽고, 그 경로에서도 바이트가 같아야 한다.
const { download } = require('../client/release');

function stubFetch(chunks, headers = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: (async function* () { for (const c of chunks) yield Buffer.from(c); })(),
    arrayBuffer: async () => Buffer.concat(chunks.map((c) => Buffer.from(c))),
  });
  return () => { globalThis.fetch = original; };
}

test('진행 콜백을 주면 스트리밍으로 받고 같은 바이트를 돌려준다', async () => {
  const chunks = ['클로', '애드', '-payload'];
  const expected = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const restore = stubFetch(chunks, { 'content-length': String(expected.length) });
  try {
    const seen = [];
    const bytes = await download('https://example.test/a.tgz', 1024, (received, total) => seen.push([received, total]));
    assert.deepStrictEqual(bytes, expected, '스트리밍 경로도 같은 바이트여야 한다');
    assert.strictEqual(seen.length, chunks.length, '청크마다 진행을 알려야 한다');
    assert.deepStrictEqual(seen[seen.length - 1], [expected.length, expected.length]);
  } finally {
    restore();
  }
});

// content-length가 없거나 거짓이면, 다 받은 뒤 검사하는 방식은 메모리를 먼저 다 쓴다.
test('스트리밍 경로는 상한을 받는 중에 검사한다', async () => {
  const restore = stubFetch(['x'.repeat(40), 'y'.repeat(40), 'z'.repeat(40)]);
  try {
    await assert.rejects(
      () => download('https://example.test/big.tgz', 50, () => {}),
      /허용 크기를 초과/,
      '상한을 넘는 순간 끊어야 한다',
    );
  } finally {
    restore();
  }
});

test('진행 콜백이 없으면 기존 경로를 그대로 쓴다', async () => {
  const restore = stubFetch(['ok-payload'], { 'content-length': '10' });
  try {
    assert.deepStrictEqual(await download('https://example.test/a.tgz', 1024), Buffer.from('ok-payload'));
  } finally {
    restore();
  }
});
