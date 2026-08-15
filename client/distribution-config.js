'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function distributionConfig() {
  return readJson(process.env.CLAWAD_DISTRIBUTION || path.join(ROOT, 'distribution.json'), {});
}

function dataDir() {
  return process.env.CLAWAD_DATA || defaultDataDir();
}

function cliBinaryStateFile(data = dataDir()) {
  return path.join(data, 'cli-binary.json');
}

// 전역 clawad 명령이 설치돼 있는지. 프로세스 spawn(which/npm 조회) 없이
// 작은 JSON 한 번만 읽는다 (CLAW-103).
function cliBinaryAvailable(data = dataDir()) {
  const state = readJson(cliBinaryStateFile(data), null);
  return Boolean(state && state.version === 1 && state.installed === true);
}

// 전역 명령이 어느 버전으로 깔렸는지 (CLAW-211). 0.2.0 이전 기록에는 없으므로 빈 문자열이
// 나올 수 있다 — 호출부는 "모른다"로 다뤄야 한다.
function cliBinaryVersion(data = dataDir()) {
  const state = readJson(cliBinaryStateFile(data), null);
  if (!state || state.version !== 1 || state.installed !== true) return '';
  return typeof state.installedVersion === 'string' ? state.installedVersion : '';
}

function serverOrigin() {
  return process.env.CLAWAD_SERVER || distributionConfig().apiOrigin || 'http://localhost:3000';
}

// 로그인은 웹 로그인 페이지에 위임한다(CLAW-100). API origin에서 유추하지 않고 배포 설정에 명시한다.
function webOrigin() {
  return process.env.CLAWAD_WEB || distributionConfig().webOrigin || 'http://localhost:8080';
}

function defaultDataDir() {
  return distributionConfig().apiOrigin ? path.join(os.homedir(), '.clawad') : path.join(ROOT, 'data');
}

function releaseManifestUrl() {
  return process.env.CLAWAD_RELEASE_MANIFEST_URL || distributionConfig().releaseManifestUrl || '';
}

// 오버레이 매니페스트 URL은 배포 시점에 distribution.json으로 주입된다. 소스 실행에서는
// 비어 있어 오버레이 설치·갱신 단계를 건너뛴다 — 개발 중에 매번 120MB를 받지 않기 위해서다.
// 설치(install.js)와 갱신(overlay-update.js)이 함께 쓰므로 여기 둔다 (CLAW-160).
function overlayManifestUrl() {
  return process.env.CLAWAD_OVERLAY_MANIFEST || distributionConfig().overlayManifestUrl || '';
}

// npm에 넘길 버전 고정 설치 스펙. 레지스트리 스펙이 있으면 그것을 쓴다 (CLAW-145) —
// tarball URL 설치는 npm allow-remote 설정과 release-assets 도메인 차단에 걸린다.
// 옛 배포물에는 packageSpec이 없으므로 packageUrl로 되돌린다.
function packageSpec() {
  const config = distributionConfig();
  return config.packageSpec || config.packageUrl || '';
}

// 배포 설치에는 저장소가 없어 npm 스크립트를 실행할 수 없다.
// 전역 clawad 명령이 있으면 그것을, 없으면 설치에 사용한 패키지 스펙으로 안내한다.
// 안내는 항상 사용자가 그대로 실행할 수 있는 명령이어야 한다.
function userCommand(sub, args = '') {
  const config = distributionConfig();
  if (!config.apiOrigin) return args ? `npm run clawad:${sub} -- ${args}` : `npm run clawad:${sub}`;
  const spec = packageSpec();
  let base;
  if (cliBinaryAvailable()) base = `clawad ${sub}`;
  else base = spec ? `npx --yes ${spec} ${sub}` : `clawad ${sub}`;
  return args ? `${base} ${args}` : base;
}

module.exports = {
  cliBinaryAvailable,
  cliBinaryStateFile,
  cliBinaryVersion,
  defaultDataDir,
  distributionConfig,
  overlayManifestUrl,
  packageSpec,
  releaseManifestUrl,
  serverOrigin,
  userCommand,
  webOrigin,
};
