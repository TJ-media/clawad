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
  return readJson(path.join(ROOT, 'distribution.json'), {});
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

// 배포 설치에는 저장소가 없어 npm 스크립트를 실행할 수 없다. 설치에 사용한 패키지 URL로 안내한다.
function userCommand(sub, args = '') {
  const config = distributionConfig();
  if (!config.apiOrigin) return args ? `npm run clawad:${sub} -- ${args}` : `npm run clawad:${sub}`;
  const base = config.packageUrl ? `npx --yes ${config.packageUrl} ${sub}` : `clawad ${sub}`;
  return args ? `${base} ${args}` : base;
}

// 상태줄은 한 줄이라 URL을 넣지 않는다. 정확한 명령은 sync·login 오류 메시지가 안내한다.
function commandHint(sub) {
  return distributionConfig().apiOrigin ? `설치에 사용한 명령으로 ${sub} 실행` : `npm run clawad:${sub}`;
}

module.exports = { commandHint, defaultDataDir, distributionConfig, releaseManifestUrl, serverOrigin, userCommand, webOrigin };
