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
  assert.ok(!fs.existsSync(path.join(stage, 'server')));
  assert.ok(!fs.existsSync(path.join(stage, 'apps')));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'dist', 'client-release', 'manifest.json'), 'utf8'), /"sha256": "[a-f0-9]{64}"/);

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
