#!/usr/bin/env node
'use strict';
// 게시된 GitHub Release가 update 경로의 계약을 만족하는지 원격에서 확인한다.
// manifest 다운로드 → 검증 → tarball SHA-256 대조 → 실제 설치로 패키지 신원 확인까지
// client/update.js와 같은 순서로 수행한다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { download, sha256, validateManifest } = require('../client/release');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MANIFEST_URL = 'https://github.com/TJ-media/clawad/releases/latest/download/manifest.json';
const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));

const manifestUrl = process.argv[2] || DEFAULT_MANIFEST_URL;
const expectedVersion = process.argv[3] || rootPackage.version;

function assetName(url) {
  return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
}

async function main() {
  const manifestBytes = await download(manifestUrl, 1024 * 1024);
  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch {
    throw new Error('게시된 manifest JSON이 손상되었습니다.');
  }
  const manifest = validateManifest(parsed);
  if (manifest.version !== expectedVersion) {
    throw new Error(`manifest version(${manifest.version})이 기대값(${expectedVersion})과 다릅니다.`);
  }
  if (!manifest.packageUrl.includes(`/download/v${manifest.version}/`)) {
    throw new Error('packageUrl이 버전 고정 태그 경로를 가리키지 않습니다.');
  }

  const packageBytes = await download(manifest.packageUrl);
  const digest = sha256(packageBytes);
  if (digest !== manifest.sha256) {
    throw new Error(`tarball SHA-256 불일치: 실제 ${digest}, manifest ${manifest.sha256}`);
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-release-verify-'));
  try {
    const archive = path.join(workdir, assetName(manifest.packageUrl) || 'clawad-cli.tgz');
    fs.writeFileSync(archive, packageBytes, { mode: 0o600 });
    // Windows에서 .cmd 직접 실행은 EINVAL이므로 npm-cli.js를 node로 실행한다(build-client-release.js와 동일).
    const npmArgs = ['install', '--prefix', workdir, '--ignore-scripts', '--no-audit', '--no-fund', archive];
    const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const installed = process.platform === 'win32'
      ? spawnSync(process.execPath, [npmCli, ...npmArgs], { encoding: 'utf8', windowsHide: true })
      : spawnSync('npm', npmArgs, { encoding: 'utf8', windowsHide: true });
    if (installed.error) throw new Error(`npm install 실행 실패: ${installed.error.message}`);
    if (installed.status !== 0) throw new Error(`게시된 패키지 설치 실패: ${(installed.stderr || '').trim()}`);

    const installedRoot = path.join(workdir, 'node_modules', '@clawad', 'cli');
    let installedPackage;
    try { installedPackage = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, '')); } catch {}
    if (!installedPackage || installedPackage.name !== '@clawad/cli' || installedPackage.version !== manifest.version) {
      throw new Error('manifest와 게시된 패키지의 이름·버전이 일치하지 않습니다.');
    }
    for (const entry of ['client/install.js', 'client/statusline.js', 'distribution.json', 'LICENSE']) {
      if (!fs.existsSync(path.join(installedRoot, entry))) throw new Error(`배포물에 ${entry}이(가) 없습니다.`);
    }
    for (const forbidden of ['server', 'apps', 'deploy', '.env']) {
      if (fs.existsSync(path.join(installedRoot, forbidden))) throw new Error(`배포물에 ${forbidden}이(가) 포함됐습니다.`);
    }
    if (installedPackage.dependencies && Object.keys(installedPackage.dependencies).length > 0) {
      throw new Error('\uD074\uB77C\uC774\uC5B8\uD2B8 \uBC30\uD3EC\uBB3C\uC740 \uC678\uBD80 \uC758\uC874\uC131\uC744 \uAC00\uC9C8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.');
    }
    const distribution = JSON.parse(fs.readFileSync(path.join(installedRoot, 'distribution.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (!/^https:\/\//.test(distribution.apiOrigin || '')) throw new Error('배포물의 apiOrigin이 HTTPS가 아닙니다.');
    if (!/^https:\/\//.test(distribution.releaseManifestUrl || '')) throw new Error('배포물의 releaseManifestUrl이 HTTPS가 아닙니다.');
    if (distribution.packageUrl !== manifest.packageUrl) throw new Error('배포물의 packageUrl이 manifest와 다릅니다.');

    console.log(`게시된 릴리스 ${manifest.version} 확인 완료`);
    console.log(`  패키지 ${manifest.packageUrl}`);
    console.log(`  SHA-256 ${digest}`);
    console.log(`  apiOrigin ${distribution.apiOrigin}`);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
