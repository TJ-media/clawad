'use strict';

// CLAW-133: 오버레이 앱(clawad-overlay)을 CLI 설치 흐름 안에서 함께 설치한다.
//
// 두 산출물을 하나의 파일로 묶지 않는다 — 각자의 저장소 릴리스에서 따로 배포하고
// 설치 흐름만 잇는다. 오버레이는 AGPL-3.0이고 이 저장소는 비오픈소스라, 하나의
// 결합 저작물로 배포하면 카피레프트가 서버 코드로 번질 위험이 있다
// (clawad-overlay/docs/BOUNDARY.md, 규칙 §8).
//
// 신뢰 경로는 CLI가 자기 tarball을 받을 때와 같다: 매니페스트를 조회해
// SHA-256을 대조한 뒤에만 실행한다. release.js의 secureUrl·download·sha256을 쓴다.

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
const INSTALLER_NAME_PATTERN = /^(?<product>[A-Za-z0-9._-]+)-Setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(?<arch>[A-Za-z0-9]+)\.exe$/;

function readManifestFields(value) {
  if (!value || typeof value !== 'object') throw new Error('오버레이 매니페스트를 읽을 수 없습니다.');
  if (!VERSION_PATTERN.test(value.version || '')) throw new Error('오버레이 매니페스트의 version이 올바르지 않습니다.');
  const url = secureUrl(value.installerUrl, 'installerUrl');
  if (!SHA256_PATTERN.test(value.sha256 || '')) throw new Error('오버레이 매니페스트의 SHA-256이 올바르지 않습니다.');

  const bytes = Number(value.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_INSTALLER_BYTES) {
    throw new Error('오버레이 매니페스트의 bytes가 올바르지 않습니다.');
  }

  const silentArgs = Array.isArray(value.silentArgs) ? value.silentArgs : ['/S'];
  for (const arg of silentArgs) {
    if (typeof arg !== 'string' || !ALLOWED_SILENT_ARGS.has(arg)) {
      throw new Error(`오버레이 매니페스트의 silentArgs에 허용되지 않은 값이 있습니다: ${String(arg)}`);
    }
  }

  // 설치 여부 판정과 실행 파일 이름은 제품명에서 나온다. 매니페스트가 명시하면 그것을 쓰고,
  // 없으면 인스톨러 파일명에서 끌어낸다 — 이름을 코드에 박지 않는다.
  const fileName = decodeURIComponent(url.pathname.split('/').pop() || '');
  const matched = INSTALLER_NAME_PATTERN.exec(fileName);
  const product = typeof value.productName === 'string' && value.productName
    ? value.productName
    : (matched && matched.groups.product);
  if (!product) throw new Error(`오버레이 인스톨러 파일명에서 제품명을 얻지 못했습니다: ${fileName}`);
  const arch = typeof value.arch === 'string' && value.arch ? value.arch : (matched && matched.groups.arch) || '';

  return {
    version: value.version,
    installerUrl: url.href,
    sha256: value.sha256,
    bytes,
    silentArgs,
    fileName,
    productName: product,
    platform: typeof value.platform === 'string' ? value.platform : 'win32',
    arch,
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : '',
    license: typeof value.license === 'string' ? value.license : '',
  };
}

/** 설치 폴더와 실행 파일 경로. electron-builder의 perMachine:false 기본 위치다. */
function installedPaths(productName, env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(localAppData, 'Programs', productName);
  return { dir, exe: path.join(dir, `${productName}.exe`) };
}

function readInstalledVersion(productName, env = process.env) {
  const { exe } = installedPaths(productName, env);
  if (!fs.existsSync(exe)) return null;
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
  return readManifestFields(parsed);
}

/**
 * 오버레이를 설치한다. 절대 throw하지 않는다 — CLI 설치를 실패시키지 않기 위해
 * 결과를 { status, ... } 로만 돌려준다. status: installed | skipped | unsupported | failed
 */
async function installOverlay(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const manifestUrl = options.manifestUrl;

  if (!manifestUrl) return { status: 'skipped', reason: 'no-manifest-url' };
  if (platform !== 'win32') {
    return { status: 'unsupported', reason: 'platform', platform };
  }
  if (env.CLAWAD_SKIP_OVERLAY_INSTALL === '1') {
    return { status: 'skipped', reason: 'opt-out' };
  }

  let manifest;
  try {
    manifest = await (options.fetchManifest || fetchManifest)(manifestUrl, options);
  } catch (err) {
    return { status: 'failed', stage: 'manifest', message: err.message };
  }

  if (manifest.platform !== platform) {
    return { status: 'unsupported', reason: 'platform-mismatch', platform, manifestPlatform: manifest.platform };
  }

  if (readInstalledVersion(manifest.productName, env)) {
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
  try {
    fs.writeFileSync(installerPath, bytes, { mode: 0o600 });
    log('  오버레이 앱을 설치합니다…');
    const result = (options.spawnSync || spawnSync)(installerPath, manifest.silentArgs, {
      stdio: 'ignore', windowsHide: true, shell: false,
    });
    if (result.error) return { status: 'failed', stage: 'run', message: result.error.message };
    if (result.status !== 0) return { status: 'failed', stage: 'run', message: `인스톨러가 코드 ${result.status}로 종료했습니다.` };
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
  if (platform !== 'win32') return { status: 'unsupported', reason: 'platform', platform };

  const { dir } = installedPaths(productName, env);
  const uninstaller = path.join(dir, `Uninstall ${productName}.exe`);
  if (!fs.existsSync(uninstaller)) return { status: 'skipped', reason: 'not-installed' };

  const result = (options.spawnSync || spawnSync)(uninstaller, ['/S'], {
    stdio: 'ignore', windowsHide: true, shell: false,
  });
  if (result.error) return { status: 'failed', message: result.error.message };
  if (result.status !== 0) return { status: 'failed', message: `제거 프로그램이 코드 ${result.status}로 종료했습니다.` };
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
