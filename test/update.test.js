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

test('macOS에서 CLI 실패 후 기존 CLI로 오버레이 갱신을 계속한다', async () => {
  const calls = [];
  const warnings = [];
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    updateCli: async () => { throw new Error('cli failed'); },
    runNode: (script) => { calls.push(script); return { status: 0 }; },
    stderr: (line) => warnings.push(line),
  });
  const result = await updater.run({ platform: 'darwin' });
  assert.strictEqual(calls[0], path.join('old-root', 'client', 'overlay-update.js'));
  assert.strictEqual(result.cli.status, 'failed');
  assert.match(warnings[0], /cli failed/);
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
