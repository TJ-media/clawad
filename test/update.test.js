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
  const updater = createUpdater({
    activeRelease: () => previous,
    readManifest: async () => ({ version: previous.version, packageUrl: 'https://example.test/clawad.tgz', sha256: 'a'.repeat(64) }),
    downloadPackage: async () => { packageDownloads += 1; return Buffer.alloc(0); },
  });

  const result = await updater.updateCli({ manifestUrl: 'https://example.test/manifest.json' });

  assert.deepStrictEqual(result, { status: 'up-to-date', version: previous.version, root: previous.root });
  assert.strictEqual(packageDownloads, 0);
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
  const updater = createUpdater({
    activeRelease: () => ({ version: '0.1.17', root: 'old-root' }),
    updateCli: async () => { throw new Error('cli failed'); },
    runNode: (script) => { calls.push(script); return { status: 0 }; },
    stderr: () => {},
  });
  const result = await updater.run({ platform: 'darwin' });
  assert.strictEqual(calls[0], path.join('old-root', 'client', 'overlay-update.js'));
  assert.strictEqual(result.cli.status, 'failed');
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
