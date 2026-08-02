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
const REGISTRY_SPEC = '@clawad/cli';

/**
 * 레지스트리에 게시된 버전 목록. 조회 실패(오프라인·레지스트리 차단)와 버전 불일치는 다르다 —
 * 전자는 경고로만 넘기고 후자만 실패시킨다. 네트워크 사정으로 릴리스 검증이 막히면 안 된다.
 */
async function registryVersions() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(REGISTRY_SPEC)}`, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.versions ? Object.keys(body.versions) : [];
  } catch {
    return null;
  }
}
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
    for (const entry of ['client/install.js', 'client/overlay-events.js', 'client/work-activity.js', 'distribution.json', 'LICENSE']) {
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
    // 설치·전역명령·안내가 쓰는 스펙. 버전이 어긋나면 새 설치자가 옛 버전을 받는다 (CLAW-145).
    if (distribution.packageSpec !== `@clawad/cli@${manifest.version}`) {
      throw new Error(`배포물의 packageSpec이 @clawad/cli@${manifest.version}이 아닙니다: ${distribution.packageSpec}`);
    }
    // 이 값이 없으면 설치가 "성공"으로 끝나고도 오버레이가 안 깔려 광고·적립이 0이다.
    // 다른 필드는 다 검사하면서 이것만 빠져 있어 문서대로 빌드해도 검증을 통과했다 (CLAW-149).
    if (!/^https:\/\//.test(distribution.overlayManifestUrl || '')) {
      throw new Error(
        '배포물에 overlayManifestUrl이 없거나 HTTPS가 아닙니다. ' +
        '이 배포본은 오버레이를 설치하지 않아 광고·적립이 발생하지 않습니다.',
      );
    }

    // GitHub 릴리스와 npm 게시는 항상 같은 버전으로 함께 나간다(2026-07-31 결정). 레지스트리는
    // 첫 설치·전역 명령이, GitHub Release는 update의 SHA-256 대조가 쓴다 — 한쪽만 올리면
    // 새 설치자와 기존 사용자가 서로 다른 버전을 받는다. 절차가 그걸 잡아준다 (CLAW-149).
    const registry = await registryVersions();
    if (registry === null) {
      console.warn(`  경고: npm 레지스트리를 조회하지 못해 버전 일치를 확인하지 못했습니다 (${REGISTRY_SPEC}).`);
    } else if (!registry.includes(manifest.version)) {
      throw new Error(
        `npm 레지스트리에 ${REGISTRY_SPEC}@${manifest.version}이 없습니다. ` +
        'GitHub 릴리스와 npm 게시는 같은 버전으로 함께 나가야 합니다.',
      );
    }

    console.log(`게시된 릴리스 ${manifest.version} 확인 완료`);
    console.log(`  패키지 ${manifest.packageUrl}`);
    console.log(`  설치 스펙 ${distribution.packageSpec}`);
    console.log(`  SHA-256 ${digest}`);
    console.log(`  apiOrigin ${distribution.apiOrigin}`);
    console.log(`  오버레이 매니페스트 ${distribution.overlayManifestUrl}`);
    if (registry !== null) console.log(`  npm 레지스트리 ${REGISTRY_SPEC}@${manifest.version} 확인됨`);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
