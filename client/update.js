#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { defaultDataDir, releaseManifestUrl } = require('./distribution-config');
const { download, sha256, validateManifest } = require('./release');

const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const RELEASES = path.join(DATA, 'releases');
const RELEASE_STATE = path.join(DATA, 'release-state.json');

function runNode(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit', env: process.env, windowsHide: true,
  });
}

function runNpm(args) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npm, args, { encoding: 'utf8', windowsHide: true });
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

async function main() {
  const previous = activeRelease();
  const manifestUrl = process.argv[2] || releaseManifestUrl();
  if (!manifestUrl) throw new Error('신뢰할 수 있는 릴리스 manifest URL이 배포 설정에 없습니다.');

  const manifestBytes = await download(manifestUrl, 1024 * 1024);
  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('릴리스 manifest JSON이 손상되었습니다.'); }
  const manifest = validateManifest(parsed);
  const packageBytes = await download(manifest.packageUrl);
  if (sha256(packageBytes) !== manifest.sha256) throw new Error('릴리스 체크섬이 일치하지 않아 업데이트를 중단했습니다.');

  fs.mkdirSync(RELEASES, { recursive: true });
  const releaseDir = path.join(RELEASES, manifest.version);
  const packageFile = path.join(DATA, `.clawad-${manifest.version}.tgz`);
  if (fs.existsSync(releaseDir)) throw new Error(`버전 ${manifest.version}은 이미 설치되어 있습니다.`);
  fs.writeFileSync(packageFile, packageBytes, { mode: 0o600 });

  try {
    fs.mkdirSync(releaseDir, { recursive: true });
    const installed = runNpm(['install', '--prefix', releaseDir, '--ignore-scripts', '--no-audit', '--no-fund', packageFile]);
    if (installed.status !== 0) throw new Error(`패키지 설치 실패: ${(installed.stderr || '').trim()}`);
    const nextRoot = path.join(releaseDir, 'node_modules', '@clawad', 'cli');
    const nextInstall = path.join(nextRoot, 'client', 'install.js');
    if (!fs.existsSync(nextInstall)) throw new Error('설치된 패키지 구조를 확인할 수 없습니다.');
    let installedPackage;
    try { installedPackage = JSON.parse(fs.readFileSync(path.join(nextRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, '')); } catch {}
    if (!installedPackage || installedPackage.name !== '@clawad/cli' || installedPackage.version !== manifest.version) {
      throw new Error('manifest와 설치된 패키지의 이름·버전이 일치하지 않습니다.');
    }
    const activated = runNode(nextInstall, ['install']);
    if (activated.status !== 0) throw new Error('새 버전 health check에 실패했습니다.');
    fs.writeFileSync(RELEASE_STATE, JSON.stringify({ version: manifest.version, root: nextRoot, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    console.log(`클로애드 ${manifest.version} 업데이트 완료.`);
  } catch (error) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
    const rollback = runNode(path.join(previous.root, 'client', 'install.js'), ['install']);
    if (rollback.status !== 0) {
      throw new Error(`업데이트 실패 후 이전 버전 복구도 실패했습니다: ${error.message}`);
    }
    throw new Error(`업데이트를 되돌렸습니다: ${error.message}`);
  } finally {
    try { fs.unlinkSync(packageFile); } catch {}
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : '업데이트에 실패했습니다.');
  process.exit(1);
});
