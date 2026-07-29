'use strict';

// CLAW-133: 오버레이 앱(clawad-overlay)을 CLI 설치 흐름 안에서 함께 설치한다.
// CLAW-92: macOS를 같은 흐름에 넣는다. 플랫폼별 산출물은 매니페스트의 artifacts에서 고른다.
//
// 두 산출물을 하나의 파일로 묶지 않는다 — 각자의 저장소 릴리스에서 따로 배포하고
// 설치 흐름만 잇는다. 오버레이는 AGPL-3.0이고 이 저장소는 비오픈소스라, 하나의
// 결합 저작물로 배포하면 카피레프트가 서버 코드로 번질 위험이 있다
// (clawad-overlay/docs/BOUNDARY.md, 규칙 §8).
//
// 신뢰 경로는 CLI가 자기 tarball을 받을 때와 같다: 매니페스트를 조회해
// SHA-256을 대조한 뒤에만 실행한다. release.js의 secureUrl·download·sha256을 쓴다.
//
// 서명 상태: 알파는 무서명으로 배포한다(CLAW-95의 예외 조항). Gatekeeper·SmartScreen
// 우회를 코드로 시도하지 않는다 — quarantine 속성이나 MOTW를 지우지 않는다. 우리가
// 내려받아 푼 파일에는 애초에 붙지 않을 뿐이고, 그 동작에 기대는 것은 방책이 아니다
// (CLAW-92 참고). 서명을 취득하면 매니페스트 형식은 그대로 두고 빌드만 바꾸면 된다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { download, secureUrl, sha256 } = require('./release');

// 인스톨러는 100 MB를 넘는다. release.js의 기본 상한(50 MB)은 CLI tarball 기준이므로
// 여기서만 따로 둔다. 매니페스트의 bytes와 대조하므로 이 값은 방어 한계일 뿐이다.
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// 무인 실행 인수는 매니페스트가 정하지만, 임의 문자열을 그대로 넘기지 않는다.
const ALLOWED_SILENT_ARGS = new Set(['/S', '/SILENT', '/VERYSILENT', '/NCRC']);
// 제품명은 파일 경로와 osascript 인수로 쓰이므로 형태를 좁게 고정한다.
const PRODUCT_PATTERN = /^[A-Za-z0-9._-]+$/;
// 산출물 이름 규칙. clawad-overlay의 electron-builder artifactName과 짝을 이룬다.
//   win32: Claw-Ad-Setup-0.1.2-x64.exe   (build.win.artifactName)
//   darwin: Claw-Ad-0.1.2-arm64.zip      (build.mac.artifactName, zip 타깃)
const INSTALLER_NAME_PATTERNS = {
  nsis: /^(?<product>[A-Za-z0-9._-]+)-Setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(?<arch>[A-Za-z0-9]+)\.exe$/,
  zip: /^(?<product>[A-Za-z0-9._-]+)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(?<arch>[A-Za-z0-9]+)\.zip$/,
};
// 플랫폼별로 받아들이는 설치 방식. 매니페스트가 엉뚱한 조합을 보내면 실행하지 않는다.
const PLATFORM_KINDS = { win32: 'nsis', darwin: 'zip' };

function artifactKey(platform, arch) {
  return `${platform}-${arch}`;
}

// 게시된 v0.1.1까지의 매니페스트는 플랫폼 하나를 평평하게 담았다. 새 CLI가 옛 매니페스트를
// 만나도 동작하도록 같은 모양으로 변환해서 읽는다 — 릴리스 순서에 의존하지 않기 위해서다.
function artifactsOf(value) {
  if (value.artifacts && typeof value.artifacts === 'object') return value.artifacts;
  const platform = typeof value.platform === 'string' ? value.platform : 'win32';
  const arch = typeof value.arch === 'string' ? value.arch : 'x64';
  return {
    [artifactKey(platform, arch)]: {
      installerUrl: value.installerUrl,
      sha256: value.sha256,
      bytes: value.bytes,
      silentArgs: value.silentArgs,
      productName: value.productName,
      kind: 'nsis',
    },
  };
}

/**
 * 매니페스트에서 현재 플랫폼·아키텍처에 맞는 산출물 하나를 골라 검증한다.
 * target을 주지 않으면 실행 중인 프로세스 기준으로 고른다.
 */
function readManifestFields(value, target = {}) {
  if (!value || typeof value !== 'object') throw new Error('오버레이 매니페스트를 읽을 수 없습니다.');
  if (!VERSION_PATTERN.test(value.version || '')) throw new Error('오버레이 매니페스트의 version이 올바르지 않습니다.');

  const platform = target.platform || process.platform;
  const arch = target.arch || process.arch;
  const expectedKind = PLATFORM_KINDS[platform];
  if (!expectedKind) throw new Error(`오버레이가 지원하지 않는 플랫폼입니다: ${platform}`);

  const artifacts = artifactsOf(value);
  const entry = artifacts[artifactKey(platform, arch)];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`오버레이 매니페스트에 ${artifactKey(platform, arch)} 산출물이 없습니다.`);
  }

  const kind = typeof entry.kind === 'string' ? entry.kind : expectedKind;
  if (kind !== expectedKind) {
    throw new Error(`${platform}에서 지원하지 않는 설치 방식입니다: ${kind}`);
  }

  const url = secureUrl(entry.installerUrl, 'installerUrl');
  if (!SHA256_PATTERN.test(entry.sha256 || '')) throw new Error('오버레이 매니페스트의 SHA-256이 올바르지 않습니다.');

  const bytes = Number(entry.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_INSTALLER_BYTES) {
    throw new Error('오버레이 매니페스트의 bytes가 올바르지 않습니다.');
  }

  // zip은 인스톨러를 실행하지 않고 풀기만 하므로 인수를 받지 않는다. 인수가 실려 오면
  // 매니페스트가 다른 설치 방식을 의도한 것이라 보고 거절한다.
  let silentArgs = [];
  if (kind === 'nsis') {
    silentArgs = Array.isArray(entry.silentArgs) ? entry.silentArgs : ['/S'];
    for (const arg of silentArgs) {
      if (typeof arg !== 'string' || !ALLOWED_SILENT_ARGS.has(arg)) {
        throw new Error(`오버레이 매니페스트의 silentArgs에 허용되지 않은 값이 있습니다: ${String(arg)}`);
      }
    }
  } else if (Array.isArray(entry.silentArgs) && entry.silentArgs.length) {
    throw new Error(`${kind} 산출물에는 silentArgs를 쓸 수 없습니다.`);
  }

  // 설치 여부 판정과 실행 파일 이름은 제품명에서 나온다. 매니페스트가 명시하면 그것을 쓰고,
  // 없으면 인스톨러 파일명에서 끌어낸다 — 이름을 코드에 박지 않는다.
  const fileName = decodeURIComponent(url.pathname.split('/').pop() || '');
  const matched = INSTALLER_NAME_PATTERNS[kind].exec(fileName);
  const product = typeof entry.productName === 'string' && entry.productName
    ? entry.productName
    : (matched && matched.groups.product);
  if (!product) throw new Error(`오버레이 인스톨러 파일명에서 제품명을 얻지 못했습니다: ${fileName}`);
  if (!PRODUCT_PATTERN.test(product)) throw new Error(`오버레이 제품명에 쓸 수 없는 문자가 있습니다: ${product}`);

  return {
    version: value.version,
    installerUrl: url.href,
    sha256: entry.sha256,
    bytes,
    kind,
    silentArgs,
    fileName,
    productName: product,
    platform,
    arch,
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : '',
    license: typeof value.license === 'string' ? value.license : '',
  };
}

/**
 * 설치 폴더와 설치 여부를 판정할 경로.
 *   win32: electron-builder NSIS perMachine:false 기본 위치
 *   darwin: 사용자 Applications — 관리자 권한 없이 쓸 수 있어야 한다(규칙 §7)
 */
function installedPaths(productName, env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    const dir = path.join(env.HOME || os.homedir(), 'Applications');
    return { dir, target: path.join(dir, `${productName}.app`) };
  }
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(localAppData, 'Programs', productName);
  return { dir, target: path.join(dir, `${productName}.exe`) };
}

function readInstalledVersion(productName, env = process.env, platform = process.platform) {
  const { target } = installedPaths(productName, env, platform);
  if (!fs.existsSync(target)) return null;
  // 실행 파일 버전을 읽으려면 외부 도구가 필요하다. 설치 여부만 확인하고 버전 비교는
  // 오버레이 자체 자동 업데이트(latest.yml)에 맡긴다 — 중복 갱신 경로를 만들지 않는다.
  return 'installed';
}

async function fetchManifest(manifestUrl, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const response = await fetchImpl(secureUrl(manifestUrl, '오버레이 매니페스트 URL').href);
  if (!response.ok) throw new Error(`오버레이 매니페스트 조회 실패 (HTTP ${response.status})`);
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('오버레이 매니페스트가 올바른 JSON이 아닙니다.');
  }
  return readManifestFields(parsed, { platform: deps.platform, arch: deps.arch });
}

// NSIS 인스톨러를 무인 실행한다.
function runNsisInstaller(installerPath, manifest, run) {
  const result = run(installerPath, manifest.silentArgs, { stdio: 'ignore', windowsHide: true, shell: false });
  if (result.error) return { ok: false, message: result.error.message };
  if (result.status !== 0) return { ok: false, message: `인스톨러가 코드 ${result.status}로 종료했습니다.` };
  return { ok: true };
}

// zip을 사용자 Applications에 푼다. ditto는 macOS 기본 도구이고 .app 번들 안의
// 심볼릭 링크와 확장 속성을 보존한다 — unzip은 Frameworks의 링크를 망가뜨린다.
function extractMacApp(archivePath, manifest, env, run) {
  const { dir, target } = installedPaths(manifest.productName, env, 'darwin');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, message: `설치 폴더를 만들지 못했습니다: ${err.message}` };
  }
  const result = run('/usr/bin/ditto', ['-x', '-k', archivePath, dir], { stdio: 'ignore', shell: false });
  if (result.error) return { ok: false, message: result.error.message };
  if (result.status !== 0) return { ok: false, message: `압축 해제가 코드 ${result.status}로 종료했습니다.` };
  if (!fs.existsSync(target)) {
    return { ok: false, message: `압축을 풀었지만 앱 번들이 없습니다: ${target}` };
  }
  return { ok: true };
}

/**
 * 오버레이를 설치한다. 절대 throw하지 않는다 — CLI 설치를 실패시키지 않기 위해
 * 결과를 { status, ... } 로만 돌려준다. status: installed | skipped | unsupported | failed
 */
async function installOverlay(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const manifestUrl = options.manifestUrl;

  if (!manifestUrl) return { status: 'skipped', reason: 'no-manifest-url' };
  if (!PLATFORM_KINDS[platform]) {
    return { status: 'unsupported', reason: 'platform', platform };
  }
  if (env.CLAWAD_SKIP_OVERLAY_INSTALL === '1') {
    return { status: 'skipped', reason: 'opt-out' };
  }

  let manifest;
  try {
    manifest = await (options.fetchManifest || fetchManifest)(manifestUrl, { ...options, platform, arch });
  } catch (err) {
    return { status: 'failed', stage: 'manifest', message: err.message };
  }

  if (manifest.platform !== platform) {
    return { status: 'unsupported', reason: 'platform-mismatch', platform, manifestPlatform: manifest.platform };
  }

  if (readInstalledVersion(manifest.productName, env, platform)) {
    return { status: 'skipped', reason: 'already-installed', productName: manifest.productName };
  }

  let bytes;
  try {
    log(`  오버레이 앱을 내려받습니다 (${(manifest.bytes / 1024 / 1024).toFixed(0)} MB)…`);
    bytes = await (options.download || download)(manifest.installerUrl, MAX_INSTALLER_BYTES);
  } catch (err) {
    return { status: 'failed', stage: 'download', message: err.message };
  }

  if (bytes.length !== manifest.bytes) {
    return { status: 'failed', stage: 'verify', message: `내려받은 크기가 매니페스트와 다릅니다 (${bytes.length} ≠ ${manifest.bytes}).` };
  }
  if (sha256(bytes) !== manifest.sha256) {
    return { status: 'failed', stage: 'verify', message: '오버레이 인스톨러 체크섬이 일치하지 않습니다.' };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-overlay-'));
  const installerPath = path.join(tempDir, manifest.fileName);
  const run = options.spawnSync || spawnSync;
  try {
    fs.writeFileSync(installerPath, bytes, { mode: 0o600 });
    log('  오버레이 앱을 설치합니다…');
    const outcome = manifest.kind === 'zip'
      ? extractMacApp(installerPath, manifest, env, run)
      : runNsisInstaller(installerPath, manifest, run);
    if (!outcome.ok) return { status: 'failed', stage: 'run', message: outcome.message };
    return {
      status: 'installed',
      version: manifest.version,
      productName: manifest.productName,
      sourceUrl: manifest.sourceUrl,
      license: manifest.license,
    };
  } catch (err) {
    return { status: 'failed', stage: 'run', message: err.message };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 오버레이를 제거한다. 설치와 마찬가지로 throw하지 않는다.
 * status: removed | skipped | unsupported | failed
 */
function uninstallOverlay(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const productName = options.productName || 'Claw-Ad';
  if (!PLATFORM_KINDS[platform]) return { status: 'unsupported', reason: 'platform', platform };
  if (!PRODUCT_PATTERN.test(productName)) return { status: 'failed', message: `제품명에 쓸 수 없는 문자가 있습니다: ${productName}` };

  const run = options.spawnSync || spawnSync;
  if (platform === 'darwin') return removeMacApp(productName, env, run);

  const { dir } = installedPaths(productName, env, platform);
  const uninstaller = path.join(dir, `Uninstall ${productName}.exe`);
  if (!fs.existsSync(uninstaller)) return { status: 'skipped', reason: 'not-installed' };

  const result = run(uninstaller, ['/S'], { stdio: 'ignore', windowsHide: true, shell: false });
  if (result.error) return { status: 'failed', message: result.error.message };
  if (result.status !== 0) return { status: 'failed', message: `제거 프로그램이 코드 ${result.status}로 종료했습니다.` };
  return { status: 'removed', productName };
}

// macOS는 제거 프로그램이 따로 없다. 실행 중이면 종료를 요청한 뒤 번들을 지운다.
// 종료 요청이 실패해도(앱이 안 떠 있는 경우 포함) 제거는 계속한다.
function removeMacApp(productName, env, run) {
  const { target } = installedPaths(productName, env, 'darwin');
  if (!fs.existsSync(target)) return { status: 'skipped', reason: 'not-installed' };

  try {
    run('/usr/bin/osascript', ['-e', `quit app "${productName}"`], { stdio: 'ignore', shell: false });
  } catch {}

  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    return { status: 'failed', message: err.message };
  }
  return { status: 'removed', productName };
}

module.exports = {
  MAX_INSTALLER_BYTES,
  fetchManifest,
  installOverlay,
  installedPaths,
  readManifestFields,
  uninstallOverlay,
};
