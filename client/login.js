#!/usr/bin/env node
// clawad — CLI 소셜 로그인 (CLAW-37, CLAW-100).
//
// 공급자 선택과 약관 동의는 웹 로그인 페이지가 처리한다. CLI는 브라우저를 열고
// 1회성 loopback(127.0.0.1) handoff code만 돌려받아 세션으로 교환한 뒤 data/auth.json에 저장한다(최소 권한).
// 토큰은 브라우저 주소를 거치지 않는다 — loopback으로 오는 값은 handoff code와 동의한 문서 버전뿐이다.
// 이 스크립트는 핫패스가 아니다. statusline.js에는 어떤 네트워크 호출도 추가하지 않는다.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { requestInitialSync } = require('./initial-sync');
const { defaultDataDir, serverOrigin, userCommand, webOrigin } = require('./distribution-config');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const AUTH_FILE = process.env.CLAWAD_AUTH || path.join(DATA, 'auth.json');
const SERVER = serverOrigin();
const WEB = webOrigin();

const REQUIRED_CONSENT_TYPES = ['TERMS_OF_SERVICE', 'PRIVACY_POLICY'];
// 웹이 동의 결과를 loopback으로 넘길 때 쓰는 쿼리 키. 문서 버전 문자열만 담고 개인정보는 담지 않는다.
const CONSENT_PARAM = { TERMS_OF_SERVICE: 'tos', PRIVACY_POLICY: 'pp' };
// 브라우저를 열어둔 채 무기한 대기하지 않는다. 사용자가 창을 닫거나 동의를 취소한 경우를 위한 상한.
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function saveAuth(pair) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ ...pair, obtainedAt: new Date().toISOString() }, null, 2) + '\n');
  // 토큰 파일은 소유자만 읽고 쓸 수 있게 한다(POSIX). Windows에서는 무시된다.
  try {
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch {}
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    process.platform === 'darwin' ? ['open', [url]] :
    ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // 브라우저 자동 실행 실패는 치명적이지 않다. 사용자가 URL을 직접 열 수 있다.
  }
}

async function postJson(pathname, body) {
  const res = await fetch(`${SERVER}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// 구버전 안내를 따라 공급자·동의 옵션을 붙여 실행해도 실패시키지 않는다. 무시한다는 사실만 알린다.
function noticeLegacyArgs(argv) {
  const legacy = argv.filter((a) => a === '--accept-terms' || a === '--accept-privacy' || !a.startsWith('--'));
  if (!legacy.length) return;
  console.log('공급자 선택과 약관 동의는 이제 브라우저 로그인 화면에서 진행합니다. 다음 인자는 무시합니다: ' + legacy.join(' '));
}

async function legalBundle() {
  const res = await fetch(`${SERVER}/v1/legal/documents`);
  const json = await res.json().catch(() => ({}));
  const types = Array.isArray(json.documents) ? new Set(json.documents.map((document) => document.type)) : new Set();
  if (!res.ok || types.size !== 2 || REQUIRED_CONSENT_TYPES.some((type) => !types.has(type))) {
    throw new Error('활성 약관·개인정보처리방침을 확인하지 못했습니다. 가입을 중단합니다.');
  }
  return json;
}

function documentVersions(bundle) {
  return REQUIRED_CONSENT_TYPES.map((type) => {
    const document = bundle.documents.find((item) => item.type === type);
    return `${type}:${document.version}`;
  }).join('|');
}

function showLegalDocuments(bundle) {
  console.log('가입 전에 아래 필수 문서를 확인하세요.');
  for (const document of bundle.documents) {
    const label = document.type === 'TERMS_OF_SERVICE' ? '서비스 이용약관' : '개인정보처리방침';
    console.log(`- ${label}: ${document.url} (버전 ${document.version}, 시행일 ${document.effectiveAt})`);
  }
  for (const disclosure of bundle.disclosures || []) console.log(`- ${disclosure}`);
  console.log(`동의하지 않는 경우 제거 안내: ${bundle.removalGuideUrl}`);
  console.log(`개인정보 문의: ${bundle.privacyContactUrl}`);
}

async function exchange(handoffCode, accepted, bundle) {
  let result = await postJson('/v1/auth/social/exchange', { handoffCode });
  if (result.ok && (result.json.signupRequired || result.json.consentRequired)) {
    const latest = await legalBundle();
    if (documentVersions(latest) !== documentVersions(bundle)) {
      showLegalDocuments(latest);
      throw new Error('로그인 중 법률 문서가 개정되었습니다. 최신 문서를 확인한 뒤 다시 실행하세요.');
    }
    // 웹 로그인 화면에서 동의한 문서 버전이 그대로 돌아왔는지 확인한다.
    // 서버도 활성 버전과 대조하므로, 여기서 통과해도 최종 판단은 서버가 한다.
    const versions = new Map(latest.documents.map((document) => [document.type, document.version]));
    const missing = REQUIRED_CONSENT_TYPES.filter((type) => accepted.get(type) !== versions.get(type));
    if (missing.length) {
      throw new Error(
        '서비스 이용약관과 개인정보처리방침에 각각 동의해야 가입·재동의할 수 있습니다.\n' +
          `브라우저 로그인 화면에서 두 문서에 동의한 뒤 다시 실행하세요: ${userCommand('login')}`,
      );
    }
    const consents = REQUIRED_CONSENT_TYPES.map((type) => ({ type, granted: true, documentVersion: versions.get(type) }));
    result = await postJson('/v1/auth/social/exchange', { handoffCode, consents });
  }
  if (result.json.error === 'CONSENT_VERSION_INVALID') {
    throw new Error('법률 문서 버전이 변경되었습니다. 최신 문서를 확인하도록 로그인을 다시 실행하세요.');
  }
  if (!result.ok || !result.json.accessToken) {
    throw new Error(`세션 발급 실패 (HTTP ${result.status})`);
  }
  return result.json;
}

function waitForCallback(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('브라우저 로그인이 제한 시간 안에 끝나지 않았습니다. 다시 실행하세요.'));
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
    const settle = (fn, value) => { clearTimeout(timer); fn(value); };

    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      // 웹이 사용자가 동의한 문서 버전을 함께 넘긴다. 서버가 활성 버전과 대조해 최종 판단한다.
      const accepted = new Map(
        REQUIRED_CONSENT_TYPES
          .map((type) => [type, url.searchParams.get(CONSENT_PARAM[type])])
          .filter(([, version]) => version),
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">` +
          `<h2>클로애드 로그인 ${code ? '완료' : '실패'}</h2>` +
          `<p>${code ? '이 창을 닫고 터미널로 돌아가세요.' : '터미널의 안내를 확인하세요.'}</p></body>`,
      );
      if (error) return settle(reject, new Error(`공급자 인증 실패: ${error}`));
      if (!code) return settle(reject, new Error('handoff code를 받지 못했습니다.'));
      settle(resolve, { code, accepted });
    });
  });
}

// 웹 로그인 페이지에 loopback 복귀 주소를 넘긴다. 공급자 선택·약관 동의는 웹이 처리한다.
function webLoginUrl(returnTarget) {
  const url = new URL(WEB);
  url.searchParams.set('cli_return', returnTarget);
  return url.toString();
}

async function main() {
  noticeLegacyArgs(process.argv.slice(2));
  const documents = await legalBundle();
  showLegalDocuments(documents);

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const returnTarget = `http://127.0.0.1:${port}/callback`;

  try {
    const loginUrl = webLoginUrl(returnTarget);
    console.log(
      '브라우저에서 로그인 수단을 선택하고 약관에 동의하세요. 자동으로 열리지 않으면 아래 주소를 여세요:\n' + loginUrl,
    );
    openBrowser(loginUrl);

    const { code, accepted } = await waitForCallback(server);
    const tokens = await exchange(code, accepted, documents);
    saveAuth(tokens);
    requestInitialSync({ data: DATA });
    console.log(`로그인 완료. 세션이 ${path.relative(ROOT, AUTH_FILE)}에 저장됐습니다. 광고를 준비하는 동기화를 시작했습니다.`);
  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
