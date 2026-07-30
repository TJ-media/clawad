#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'client-release');
const STAGE = path.join(DIST, 'package');
const sourcePackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const PACKAGE_NAME = '@clawad/cli';

function httpsOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch {}
  if (!url || url.protocol !== 'https:' || url.origin !== url.href.replace(/\/$/, '') || url.username || url.password) {
    throw new Error(`${name}은 경로·자격증명 없는 HTTPS origin이어야 합니다.`);
  }
  return url.origin;
}

function httpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name}은 자격증명 없는 HTTPS URL이어야 합니다.`);
  return url.href;
}

// 업로드할 자산 파일명은 manifest packageUrl의 파일명과 반드시 같아야 한다.
// 다르면 게시 후 update가 없는 URL을 내려받아 실패한다.
function assetName(url, name) {
  const value = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  if (!value.endsWith('.tgz') || value === '.tgz' || value.startsWith('.') || path.basename(value) !== value) {
    throw new Error(`${name}의 파일명은 경로 없는 .tgz여야 합니다.`);
  }
  return value;
}

const apiOrigin = httpsOrigin(process.env.CLAWAD_RELEASE_API_ORIGIN, 'CLAWAD_RELEASE_API_ORIGIN');
// 로그인 페이지 origin. API origin에서 유추하면 배포 구성이 바뀔 때 조용히 깨지므로 명시적으로 받는다.
const webOrigin = httpsOrigin(process.env.CLAWAD_RELEASE_WEB_ORIGIN, 'CLAWAD_RELEASE_WEB_ORIGIN');
const manifestUrl = httpsUrl(process.env.CLAWAD_RELEASE_MANIFEST_URL, 'CLAWAD_RELEASE_MANIFEST_URL');
const packageUrl = httpsUrl(process.env.CLAWAD_RELEASE_PACKAGE_URL, 'CLAWAD_RELEASE_PACKAGE_URL');
const packageFile = assetName(packageUrl, 'CLAWAD_RELEASE_PACKAGE_URL');
// 통합 설치(CLAW-133)가 조회할 오버레이 매니페스트. 오버레이는 별도 저장소에서 따로
// 배포되므로 URL만 주입한다 — 인스톨러 사본을 이 릴리스에 넣지 않는다(AGPL 격리).
// 지정하지 않으면 배포본에서 오버레이 설치 단계가 건너뛰어진다.
const overlayManifestUrl = process.env.CLAWAD_RELEASE_OVERLAY_MANIFEST_URL
  ? httpsUrl(process.env.CLAWAD_RELEASE_OVERLAY_MANIFEST_URL, 'CLAWAD_RELEASE_OVERLAY_MANIFEST_URL')
  : '';
// packageUrl은 latest가 아니라 버전 고정 태그 경로여야 게시 후에도 내용이 바뀌지 않는다.
if (!packageUrl.includes(`/download/v${sourcePackage.version}/`)) {
  throw new Error(`CLAWAD_RELEASE_PACKAGE_URL은 /download/v${sourcePackage.version}/ 경로를 가리켜야 합니다.`);
}
// 안내·전역설치용 레지스트리 스펙(CLAW-145). packageUrl과 역할이 다르다 —
// packageUrl은 update의 SHA-256 무결성 계약용이라 그대로 두고, npm이 실행하는
// 설치 스펙만 레지스트리로 옮긴다. tarball URL 설치는 npm allow-remote 설정과
// release-assets 도메인 차단에 걸려 관리형 PC에서 실패한다.
const packageSpec = `${PACKAGE_NAME}@${sourcePackage.version}`;

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(path.join(ROOT, 'client'), path.join(STAGE, 'client'), { recursive: true });
fs.cpSync(path.join(ROOT, 'policy'), path.join(STAGE, 'policy'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(STAGE, 'README.md'));
// 배포물에는 실행을 허가하는 클라이언트 이용 라이선스를 넣는다. 저장소 LICENSE(열람 전용)는
// 실행·설치를 금지하므로 실행하도록 배포하는 패키지에 그대로 넣을 수 없다 (CLAW-145).
fs.copyFileSync(path.join(ROOT, 'LICENSE-CLIENT'), path.join(STAGE, 'LICENSE'));
// packageUrl은 배포 설치가 사용자에게 실행 가능한 명령을 안내하기 위해 필요하다(저장소 npm 스크립트 사용 불가).
fs.writeFileSync(path.join(STAGE, 'distribution.json'), JSON.stringify({ apiOrigin, webOrigin, releaseManifestUrl: manifestUrl, packageUrl, packageSpec, ...(overlayManifestUrl ? { overlayManifestUrl } : {}) }, null, 2) + '\n');
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
  name: PACKAGE_NAME,
  version: sourcePackage.version,
  description: sourcePackage.description,
  repository: { type: 'git', url: 'https://github.com/TJ-media/clawad.git' },
  license: 'SEE LICENSE IN LICENSE',
  engines: { node: '>=24' },
  bin: { clawad: 'client/cli.js' },
  files: ['client', 'policy', 'distribution.json', 'README.md', 'LICENSE'],
}, null, 2) + '\n');

const npmArgs = ['pack', '--pack-destination', DIST];
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const packed = process.platform === 'win32'
  ? spawnSync(process.execPath, [npmCli, ...npmArgs], { cwd: STAGE, encoding: 'utf8', windowsHide: true })
  : spawnSync('npm', npmArgs, { cwd: STAGE, encoding: 'utf8', windowsHide: true });
if (packed.error) throw new Error(`npm pack 실행 실패: ${packed.error.message}`);
if (packed.status !== 0) throw new Error((packed.stderr || 'npm pack 실패').trim());
const filename = packed.stdout.trim().split(/\r?\n/).pop();
const archive = path.join(DIST, packageFile);
if (path.join(DIST, filename) !== archive) fs.renameSync(path.join(DIST, filename), archive);
const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const manifest = path.join(DIST, 'manifest.json');
fs.writeFileSync(manifest, JSON.stringify({ version: sourcePackage.version, packageUrl, sha256: digest }, null, 2) + '\n');
console.log(`${archive}\nSHA-256 ${digest}\n게시할 자산 이름: ${packageFile}, manifest.json`);
