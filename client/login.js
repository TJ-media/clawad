#!/usr/bin/env node
// clawad — CLI 소셜 로그인 (CLAW-37).
//
// 브라우저로 Google·Kakao·Naver 인증을 진행하고, 1회성 loopback(127.0.0.1) handoff로
// 세션 토큰을 받아 data/auth.json에 저장한다(최소 권한). refresh 토큰 회전은 sync가 유지한다.
// 이 스크립트는 핫패스가 아니다. statusline.js에는 어떤 네트워크 호출도 추가하지 않는다.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || path.join(ROOT, 'data');
const AUTH_FILE = process.env.CLAWAD_AUTH || path.join(DATA, 'auth.json');
const SERVER = process.env.CLAWAD_SERVER || 'http://localhost:3000';

const ALLOWED_PROVIDERS = ['google', 'kakao', 'naver'];
// 최초 가입 시 필수 동의. 사용자가 약관·개인정보를 확인했음을 --accept-terms=<버전>으로 명시할 때만 보낸다.
const REQUIRED_CONSENT_TYPES = ['TERMS_OF_SERVICE', 'PRIVACY_POLICY'];

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

function parseArgs(argv) {
  const provider = (argv.find((a) => !a.startsWith('--')) || 'google').toLowerCase();
  const acceptArg = argv.find((a) => a.startsWith('--accept-terms'));
  const acceptVersion = acceptArg ? acceptArg.split('=')[1] || 'v0' : null;
  return { provider, acceptVersion };
}

async function exchange(handoffCode, acceptVersion) {
  let result = await postJson('/v1/auth/social/exchange', { handoffCode });
  if (result.ok && result.json.signupRequired) {
    // 최초 가입: 필수 동의가 있어야 계정이 생성된다.
    if (!acceptVersion) {
      throw new Error(
        '최초 로그인은 서비스 약관·개인정보 동의가 필요합니다.\n' +
          '약관을 확인한 뒤 다시 실행하세요: clawad:login ' +
          '<provider> --accept-terms=<약관버전>',
      );
    }
    const consents = REQUIRED_CONSENT_TYPES.map((type) => ({ type, granted: true, documentVersion: acceptVersion }));
    result = await postJson('/v1/auth/social/exchange', { handoffCode, consents });
  }
  if (!result.ok || !result.json.accessToken) {
    throw new Error(`세션 발급 실패 (HTTP ${result.status})`);
  }
  return result.json;
}

function waitForCallback(server) {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">` +
          `<h2>클로애드 로그인 ${code ? '완료' : '실패'}</h2>` +
          `<p>${code ? '이 창을 닫고 터미널로 돌아가세요.' : '터미널의 안내를 확인하세요.'}</p></body>`,
      );
      if (error) return reject(new Error(`공급자 인증 실패: ${error}`));
      if (!code) return reject(new Error('handoff code를 받지 못했습니다.'));
      resolve(code);
    });
  });
}

async function main() {
  const { provider, acceptVersion } = parseArgs(process.argv.slice(2));
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    throw new Error(`지원하지 않는 공급자입니다: ${provider} (google·kakao·naver 중 하나)`);
  }

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const returnTarget = `http://127.0.0.1:${port}/callback`;

  try {
    const start = await postJson(`/v1/auth/social/${provider}/start`, { intent: 'LOGIN', returnTarget });
    if (!start.ok || !start.json.authorizationUrl) {
      throw new Error(`로그인 시작 실패 (HTTP ${start.status}) — 서버 소셜 설정을 확인하세요.`);
    }
    console.log(`브라우저에서 ${provider} 로그인을 진행하세요. 자동으로 열리지 않으면 아래 주소를 여세요:\n${start.json.authorizationUrl}`);
    openBrowser(start.json.authorizationUrl);

    const handoffCode = await waitForCallback(server);
    const tokens = await exchange(handoffCode, acceptVersion);
    saveAuth(tokens);
    console.log(`로그인 완료. 세션이 ${path.relative(ROOT, AUTH_FILE)}에 저장됐습니다.`);
  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
