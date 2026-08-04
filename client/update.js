#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { defaultDataDir, releaseManifestUrl } = require('./distribution-config');
const { download, npmInvocation, sha256, validateManifest } = require('./release');

const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const RELEASES = path.join(DATA, 'releases');
const RELEASE_STATE = path.join(DATA, 'release-state.json');

function runNode(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit', env: process.env, windowsHide: true,
  });
}

function runNpm(args) {
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`npm을 실행할 수 없습니다: ${result.error.message}`);
  return result;
}

function activeRelease() {
  let state;
  try { state = JSON.parse(fs.readFileSync(RELEASE_STATE, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  if (!state || typeof state.root !== 'string' || typeof state.version !== 'string' ||
      !fs.existsSync(path.join(state.root, 'client', 'install.js'))) {
    throw new Error('현재 안정 버전을 확인할 수 없습니다. 같은 버전의 `setup`을 다시 실행하세요.');
  }
  return state;
}

async function readAndValidateManifest(manifestUrl, downloadImpl) {
  if (!manifestUrl) throw new Error('다운로드할 릴리스 manifest URL이 배포 설정에 없습니다.');
  const manifestBytes = await downloadImpl(manifestUrl, 1024 * 1024);
  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('릴리스 manifest JSON이 손상되었습니다.'); }
  return validateManifest(parsed);
}

function installAndActivateRelease(previous, manifest, deps) {
  const fsImpl = deps.fs;
  const runNpmImpl = deps.runNpm;
  const runNodeImpl = deps.runNode;
  const downloadImpl = deps.download;
  const releases = deps.releases;
  const data = deps.data;

  return (async () => {
    const packageBytes = await downloadImpl(manifest.packageUrl);
    if (sha256(packageBytes) !== manifest.sha256) {
      throw new Error('릴리스 체크섬이 일치하지 않아 업데이트를 중단했습니다.');
    }

    fsImpl.mkdirSync(releases, { recursive: true });
    const releaseDir = path.join(releases, manifest.version);
    const packageFile = path.join(data, `.clawad-${manifest.version}.tgz`);
    let createdRelease = false;

    try {
      if (fsImpl.existsSync(releaseDir)) throw new Error(`버전 ${manifest.version}은 이미 설치되어 있습니다.`);
      fsImpl.writeFileSync(packageFile, packageBytes, { mode: 0o600 });
      fsImpl.mkdirSync(releaseDir, { recursive: true });
      createdRelease = true;
      const installed = runNpmImpl(['install', '--prefix', releaseDir, '--ignore-scripts', '--no-audit', '--no-fund', packageFile]);
      if (installed.status !== 0) throw new Error(`패키지 설치 실패: ${(installed.stderr || '').trim()}`);
      const nextRoot = path.join(releaseDir, 'node_modules', '@clawad', 'cli');
      const nextInstall = path.join(nextRoot, 'client', 'install.js');
      if (!fsImpl.existsSync(nextInstall)) throw new Error('설치된 패키지 구조를 확인할 수 없습니다.');
      let installedPackage;
      try { installedPackage = JSON.parse(fsImpl.readFileSync(path.join(nextRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, '')); } catch {}
      if (!installedPackage || installedPackage.name !== '@clawad/cli' || installedPackage.version !== manifest.version) {
        throw new Error('manifest와 설치된 패키지의 이름·버전이 일치하지 않습니다.');
      }
      const activated = runNodeImpl(nextInstall, ['install']);
      if (activated.status !== 0) throw new Error('새 버전 health check에 실패했습니다.');
      fsImpl.writeFileSync(RELEASE_STATE, JSON.stringify({ version: manifest.version, root: nextRoot, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
      return { status: 'updated', version: manifest.version, root: nextRoot };
    } catch (error) {
      if (createdRelease) fsImpl.rmSync(releaseDir, { recursive: true, force: true });
      const rollback = runNodeImpl(path.join(previous.root, 'client', 'install.js'), ['install']);
      if (rollback.status !== 0) {
        throw new Error(`업데이트 실패 후 이전 버전 복구도 실패했습니다: ${error.message}`);
      }
      throw new Error(`업데이트를 되돌렸습니다: ${error.message}`);
    } finally {
      try { fsImpl.unlinkSync(packageFile); } catch {}
    }
  })();
}

function createUpdater(deps = {}) {
  const getActiveRelease = deps.activeRelease || activeRelease;
  const fsImpl = deps.fs || fs;
  const downloadImpl = deps.download || download;
  const runNpmImpl = deps.runNpm || runNpm;
  const runNodeImpl = deps.runNode || runNode;
  const releaseManifestUrlImpl = deps.releaseManifestUrl || releaseManifestUrl;
  const readManifestImpl = deps.readManifest || ((manifestUrl) => readAndValidateManifest(manifestUrl, downloadImpl));
  const installReleaseImpl = deps.installRelease || ((previous, manifest) => installAndActivateRelease(previous, manifest, {
    fs: fsImpl, download: downloadImpl, runNpm: runNpmImpl, runNode: runNodeImpl, releases: RELEASES, data: DATA,
  }));

  async function updateCli(options = {}) {
    if (typeof deps.updateCli === 'function') return deps.updateCli(options);
    const previous = getActiveRelease();
    const manifest = await readManifestImpl(options.manifestUrl || releaseManifestUrlImpl());
    if (manifest.version === previous.version && fsImpl.existsSync(path.join(previous.root, 'client', 'install.js'))) {
      return { status: 'up-to-date', version: previous.version, root: previous.root };
    }
    return installReleaseImpl(previous, manifest);
  }

  async function run(options = {}) {
    const platform = options.platform || process.platform;
    const previous = getActiveRelease();
    let cli;
    let cliError = null;
    try { cli = await updateCli(options); }
    catch (error) { cliError = error; cli = { status: 'failed', message: error.message, root: previous.root }; }

    if (platform !== 'darwin') {
      if (cliError) throw cliError;
      return { cli, overlay: null };
    }

    const overlayRoot = cli.status === 'updated' || cli.status === 'up-to-date' ? cli.root : previous.root;
    const child = runNodeImpl(path.join(overlayRoot, 'client', 'overlay-update.js'));
    if (!child || child.status !== 0) throw new Error('오버레이 업데이트에 실패했습니다.');
    if (cliError) (deps.stderr || console.error)(`CLI 업데이트 실패: ${cliError.message}`);
    return { cli, overlay: { status: 'updated', root: overlayRoot } };
  }

  return { run, updateCli };
}

module.exports = { createUpdater };

if (require.main === module) {
  createUpdater().run({ manifestUrl: process.argv[2] })
    .then((result) => {
      const version = result.cli.version || 'unknown';
      console.log(`클로애드 ${version} 업데이트 완료.`);
    })
    .catch((error) => {
      console.error(error && error.message ? error.message : '업데이트에 실패했습니다.');
      process.exitCode = 1;
    });
}
