#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { cliBinaryAvailable, cliBinaryVersion, defaultDataDir, releaseManifestUrl } = require('./distribution-config');
const cliBinary = require('./cli-binary');
const { installedPaths } = require('./overlay-install');
const { relaunch } = require('./overlay-update');
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
  const getActiveRelease = deps.activeRelease;
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
    let ownsPackageFile = false;
    let activationAttempted = false;

    function activeTarget() {
      let current;
      try { current = getActiveRelease(); } catch { return null; }
      if (!current || current.version !== manifest.version) return null;
      return { status: 'up-to-date', version: current.version, root: current.root };
    }

    try {
      if (fsImpl.existsSync(releaseDir)) {
        const current = activeTarget();
        if (current) return current;
        throw new Error(`버전 ${manifest.version}은 이미 설치 중이거나 설치되어 있습니다.`);
      }
      try { fsImpl.mkdirSync(releaseDir); }
      catch (error) {
        if (error && error.code === 'EEXIST') {
          const current = activeTarget();
          if (current) return current;
        }
        throw error;
      }
      createdRelease = true;
      ownsPackageFile = true;
      fsImpl.writeFileSync(packageFile, packageBytes, { mode: 0o600 });
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
      activationAttempted = true;
      // 갱신은 설치 문구를 되풀이하지 않는다 (CLAW-220). 상태가 그대로임을 알리는 줄만
      // 빠지고 실패·경고는 그대로 나온다. 구 릴리스의 install은 이 인자를 무시한다.
      const activated = runNodeImpl(nextInstall, ['install', '--quiet']);
      if (activated.status !== 0) throw new Error('새 버전 health check에 실패했습니다.');
      fsImpl.writeFileSync(RELEASE_STATE, JSON.stringify({ version: manifest.version, root: nextRoot, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
      return { status: 'updated', version: manifest.version, root: nextRoot };
    } catch (error) {
      if (createdRelease) fsImpl.rmSync(releaseDir, { recursive: true, force: true });
      if (!activationAttempted) throw error;
      const rollback = runNodeImpl(path.join(previous.root, 'client', 'install.js'), ['install']);
      if (rollback.status !== 0) {
        throw new Error(`업데이트 실패 후 이전 버전 복구도 실패했습니다: ${error.message}`);
      }
      throw new Error(`업데이트를 되돌렸습니다: ${error.message}`);
    } finally {
      if (ownsPackageFile) {
        try { fsImpl.unlinkSync(packageFile); } catch {}
      }
    }
  })();
}

function createUpdater(deps = {}) {
  const getActiveRelease = deps.activeRelease || activeRelease;
  const fsImpl = deps.fs || fs;
  const downloadImpl = deps.download || download;
  const runNpmImpl = deps.runNpm || runNpm;
  const runNodeImpl = deps.runNode || runNode;
  const envImpl = deps.env || process.env;
  const installedPathsImpl = deps.installedPaths || installedPaths;
  const relaunchOverlayImpl = deps.relaunchOverlay || relaunch;
  const releaseManifestUrlImpl = deps.releaseManifestUrl || releaseManifestUrl;
  const stdoutImpl = deps.stdout || console.log;
  const stderrImpl = deps.stderr || console.error;
  const readManifestImpl = deps.readManifest || ((manifestUrl) => readAndValidateManifest(manifestUrl, downloadImpl));
  const installReleaseImpl = deps.installRelease || ((previous, manifest) => installAndActivateRelease(previous, manifest, {
    fs: fsImpl, download: downloadImpl, activeRelease: getActiveRelease,
    runNpm: runNpmImpl, runNode: runNodeImpl, releases: RELEASES, data: DATA,
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

  /**
   * 전역 `clawad` 명령이 릴리스와 다른 버전에 고정돼 있으면 다시 설치한다 (CLAW-211).
   *
   * 전역 명령 갱신은 릴리스 설치의 **부수 효과**였다. 릴리스가 이미 최신이면 updateCli가
   * up-to-date로 빠져나가 여기까지 오지 않았고, 그래서 한 번 실패하면(예: 레지스트리에 없는
   * 버전을 설치하려다 ETARGET) `update`를 몇 번 돌려도 복구되지 않았다. 실측: 릴리스 0.1.22 /
   * 전역 명령 0.1.20, macOS 2026-08-15.
   *
   * 설치한 적이 없으면 건드리지 않는다 — 전역 설치는 선택 단계다(CLAW-103). 기록에 버전이
   * 없으면(0.2.0 이전 설치) 모르는 것이므로 한 번 맞춰 둔다.
   */
  function repairCliBinary(cli, log) {
    if (!cli || typeof cli.version !== 'string' || !cli.version) return null;
    if (!(deps.cliBinaryAvailable || cliBinaryAvailable)(DATA)) return null;
    if ((deps.cliBinaryVersion || cliBinaryVersion)(DATA) === cli.version) return null;

    const spec = `${cliBinary.PACKAGE_NAME}@${cli.version}`;
    const result = (deps.installCliBinary || cliBinary.install)(DATA, spec);
    if (result.installed) log(`전역 clawad 명령을 ${cli.version}으로 맞췄습니다.`);
    else if (!result.skipped) log(`전역 clawad 명령을 갱신하지 못했습니다(선택 단계). 사유: ${result.reason}`);
    return result;
  }

  function launchInstalledWindowsOverlay(platform) {
    if (platform !== 'win32' || envImpl.CLAWAD_SKIP_OVERLAY_INSTALL === '1') return;
    try {
      const productName = 'Claw-Ad';
      const paths = installedPathsImpl(productName, envImpl, platform);
      if (!paths || !fsImpl.existsSync(paths.target)) return;
      const warnLaunchFailure = () => {
        stderrImpl('오버레이 앱을 자동으로 실행하지 못했습니다. 시작 메뉴에서 Claw-Ad를 실행하세요.');
      };
      const launched = relaunchOverlayImpl(productName, {
        platform, env: envImpl, installedPaths: installedPathsImpl, onError: warnLaunchFailure,
      });
      if (!launched) warnLaunchFailure();
    } catch {
      stderrImpl('오버레이 앱을 자동으로 실행하지 못했습니다. 시작 메뉴에서 Claw-Ad를 실행하세요.');
    }
  }

  async function run(options = {}) {
    try {
      const platform = options.platform || process.platform;
      const previous = getActiveRelease();
      let cli;
      let cliError = null;
      try { cli = await updateCli(options); }
      catch (error) { cliError = error; cli = { status: 'failed', message: error.message, root: previous.root }; }

      // 릴리스가 최신이어도 전역 명령은 뒤처져 있을 수 있다. 오버레이보다 먼저 본다 —
      // 오버레이 갱신이 실패해도 전역 명령은 맞춰져야 한다.
      if (cli.status === 'updated' || cli.status === 'up-to-date') repairCliBinary(cli, stdoutImpl);

      let result;
      if (platform !== 'darwin') {
        if (cliError) throw cliError;
        launchInstalledWindowsOverlay(platform);
        result = { cli, overlay: null };
      } else {
        const overlayRoot = cli.status === 'updated' || cli.status === 'up-to-date' ? cli.root : previous.root;
        const child = runNodeImpl(path.join(overlayRoot, 'client', 'overlay-update.js'));
        if (!child || child.status !== 0) throw new Error('오버레이 업데이트에 실패했습니다.');
        if (cliError) stderrImpl(`CLI 업데이트 실패: ${cliError.message}`);
        result = { cli, overlay: { status: 'updated', root: overlayRoot } };
      }
      if (options.report) stdoutImpl(`클로애드 ${result.cli.version || 'unknown'} 업데이트 완료.`);
      return result;
    } catch (error) {
      if (options.report) stderrImpl(error && error.message ? error.message : '업데이트에 실패했습니다.');
      throw error;
    }
  }

  return { run, updateCli };
}

module.exports = { createUpdater };

if (require.main === module) {
  createUpdater().run({ manifestUrl: process.argv[2], report: true })
    .catch(() => {
      process.exitCode = 1;
    });
}
