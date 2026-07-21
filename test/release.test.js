'use strict';

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
      CLAWAD_RELEASE_MANIFEST_URL: 'https://github.com/TJ-media/clawad/releases/latest/download/manifest.json',
      CLAWAD_RELEASE_PACKAGE_URL: 'https://github.com/TJ-media/clawad/releases/download/v0.1.0/',
    },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /\.tgz/);
});

test('클라이언트 배포물은 런타임 파일만 포함하고 운영 설정을 고정한다', () => {
  const env = {
    ...process.env,
    CLAWAD_RELEASE_API_ORIGIN: 'https://api.clawad.test',
    CLAWAD_RELEASE_MANIFEST_URL: 'https://github.com/TJ-media/clawad/releases/latest/download/manifest.json',
    CLAWAD_RELEASE_PACKAGE_URL: 'https://github.com/TJ-media/clawad/releases/download/v0.1.0/clawad-cli.tgz',
  };
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-client-release.js')], { env, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const stage = path.join(__dirname, '..', 'dist', 'client-release', 'package');
  const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(stage, 'distribution.json'), 'utf8'));
  assert.deepStrictEqual(pkg.files, ['client', 'policy', 'distribution.json', 'README.md', 'LICENSE']);
  assert.strictEqual(pkg.license, 'SEE LICENSE IN LICENSE');
  assert.strictEqual(
    fs.readFileSync(path.join(stage, 'LICENSE'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8'),
  );
  assert.strictEqual(pkg.engines.node, '>=24');
  assert.strictEqual(config.apiOrigin, 'https://api.clawad.test');
  assert.strictEqual(config.packageUrl, 'https://github.com/TJ-media/clawad/releases/download/v0.1.0/clawad-cli.tgz');
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

  // 배포 설치에는 저장소가 없으므로 저장소 전용 npm 스크립트를 안내하면 사용자가 따라할 수 없다.
  const statusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-login-hint-'));
  const statusline = spawnSync(process.execPath, [path.join(stage, 'client', 'statusline.js')], {
    encoding: 'utf8', input: '{}', env: { ...process.env, CLAWAD_DATA: statusHome, CLAWAD_ACCESS_TOKEN: '' },
  });
  assert.strictEqual(statusline.status, 0);
  assert.doesNotMatch(statusline.stdout, /npm run clawad:/);
  assert.match(statusline.stdout, /로그인 필요/);
  assert.strictEqual(statusline.stdout.trimEnd().split('\n').length, 1);

  fs.writeFileSync(path.join(statusHome, 'paused'), '');
  const paused = spawnSync(process.execPath, [path.join(stage, 'client', 'statusline.js')], {
    encoding: 'utf8', input: '{}', env: { ...process.env, CLAWAD_DATA: statusHome },
  });
  assert.strictEqual(paused.status, 0);
  assert.doesNotMatch(paused.stdout, /npm run clawad:/);
  assert.match(paused.stdout, /일시중지/);
  fs.unlinkSync(path.join(statusHome, 'paused'));

  const syncFailure = spawnSync(process.execPath, [path.join(stage, 'client', 'sync.js')], {
    encoding: 'utf8', env: { ...process.env, CLAWAD_DATA: statusHome },
  });
  assert.doesNotMatch(`${syncFailure.stdout}${syncFailure.stderr}`, /npm run clawad:login/);
  assert.match(`${syncFailure.stdout}${syncFailure.stderr}`, /npx --yes https:\/\/github\.com\/TJ-media\/clawad\/releases\/download\/v0\.1\.0\/clawad-cli\.tgz login/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-distribution-'));
  const data = path.join(home, 'data');
  const settings = path.join(home, 'settings.json');
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
    },
  });
  assert.strictEqual(setup.status, 1);
  assert.match(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, /releases.*0\.1\.0.*package.*statusline-wrapper\.js/);
  assert.ok(fs.existsSync(path.join(data, 'releases', '0.1.0', 'package', 'client', 'statusline.js')));
  const releaseState = JSON.parse(fs.readFileSync(path.join(data, 'release-state.json'), 'utf8'));
  assert.strictEqual(releaseState.version, '0.1.0');
  assert.match(releaseState.root, /releases.*0\.1\.0.*package/);
});
