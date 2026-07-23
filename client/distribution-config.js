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

// 전역 clawad 명령이 설치돼 있는지. 핫패스(statusline)에서도 호출되므로
// 프로세스 spawn(which/npm 조회) 없이 작은 JSON 한 번만 읽는다 (CLAW-103).
function cliBinaryAvailable(data = dataDir()) {
  const state = readJson(cliBinaryStateFile(data), null);
  return Boolean(state && state.version === 1 && state.installed === true);
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

// 배포 설치에는 저장소가 없어 npm 스크립트를 실행할 수 없다.
// 전역 clawad 명령이 있으면 그것을, 없으면 설치에 사용한 패키지 URL로 안내한다.
// 안내는 항상 사용자가 그대로 실행할 수 있는 명령이어야 한다.
function userCommand(sub, args = '') {
  const config = distributionConfig();
  if (!config.apiOrigin) return args ? `npm run clawad:${sub} -- ${args}` : `npm run clawad:${sub}`;
  let base;
  if (cliBinaryAvailable()) base = `clawad ${sub}`;
  else base = config.packageUrl ? `npx --yes ${config.packageUrl} ${sub}` : `clawad ${sub}`;
  return args ? `${base} ${args}` : base;
}

// 상태줄은 한 줄이라 긴 URL을 넣지 않는다. 전역 명령이 있으면 짧은 명령을 그대로 보여주고,
// 없으면 설치에 쓴 명령을 안내한다(정확한 명령은 sync·login 오류 메시지가 안내한다).
function commandHint(sub) {
  if (!distributionConfig().apiOrigin) return `npm run clawad:${sub}`;
  return cliBinaryAvailable() ? `clawad ${sub}` : `설치에 사용한 명령으로 ${sub} 실행`;
}

module.exports = {
  cliBinaryAvailable,
  cliBinaryStateFile,
  commandHint,
  defaultDataDir,
  distributionConfig,
  releaseManifestUrl,
  serverOrigin,
  userCommand,
  webOrigin,
};
