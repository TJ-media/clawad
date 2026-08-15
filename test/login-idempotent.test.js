'use strict';
// 이미 로그인된 상태에서 login이 브라우저를 열지 않는다 (CLAW-213).
//
// 설치를 다시 실행하는 경로가 있어서(Codex를 나중에 설치했을 때 등) login은 여러 번 불린다.
// 그때마다 로그인 창이 뜨면 사용자는 자기가 뭘 잘못했는지 찾게 된다.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOGIN = path.join(__dirname, '..', 'client', 'login.js');

/** 세션 갱신만 응답하는 최소 서버. 법률 문서는 일부러 막아 --force 경로가 빨리 끝나게 한다. */
function startServer(refreshStatus) {
  const calls = { refresh: 0, legal: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/auth/refresh') {
      calls.refresh += 1;
      res.writeHead(refreshStatus, { 'Content-Type': 'application/json' });
      res.end(refreshStatus === 200
        ? JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh' })
        : JSON.stringify({ error: 'SESSION_EXPIRED' }));
      return;
    }
    if (req.url === '/v1/legal/documents') calls.legal += 1;
    res.writeHead(503).end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

function makeEnv(port, auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-login-'));
  const authFile = path.join(dir, 'auth.json');
  if (auth) fs.writeFileSync(authFile, JSON.stringify(auth));
  return {
    ...process.env,
    CLAWAD_DATA: dir,
    CLAWAD_AUTH: authFile,
    CLAWAD_SERVER: `http://127.0.0.1:${port}`,
    CLAWAD_WEB: `http://127.0.0.1:${port}`,
    // 브라우저가 열리면 안 되는 테스트다. 열려도 사람이 볼 수 없는 CI를 위해 실패로 남긴다.
    CLAWAD_SCHEDULER_DRY_RUN: '1',
  };
}

// spawnSync는 이벤트 루프를 막아 같은 프로세스의 테스트 서버가 응답하지 못한다.
function runLogin(env, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LOGIN, ...args], { env });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('유효한 세션이 있으면 브라우저를 열지 않고 끝낸다 (CLAW-213)', async () => {
  const { server, calls, port } = await startServer(200);
  try {
    const env = makeEnv(port, { accessToken: 'old-access', refreshToken: 'old-refresh' });
    const r = await runLogin(env);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /이미 로그인돼 있습니다/);
    assert.doesNotMatch(r.stdout, /브라우저에서 로그인 수단을 선택/, '로그인 화면 안내가 나오면 안 된다');
    assert.strictEqual(calls.refresh, 1, '세션 확인은 서버에 물어본다');
    assert.strictEqual(calls.legal, 0, '단축 경로에서는 문서를 받지 않는다');
    // 회전된 refresh 토큰은 1회성이므로 즉시 저장돼야 한다 (CLAW-37).
    const saved = JSON.parse(fs.readFileSync(env.CLAWAD_AUTH, 'utf8'));
    assert.strictEqual(saved.refreshToken, 'new-refresh');
  } finally {
    server.close();
  }
});

test('세션이 폐기됐으면 로그인을 진행한다 (CLAW-213)', async () => {
  const { server, calls, port } = await startServer(401);
  try {
    const r = await runLogin(makeEnv(port, { accessToken: 'old-access', refreshToken: 'revoked' }));
    assert.doesNotMatch(r.stdout, /이미 로그인돼 있습니다/);
    assert.strictEqual(calls.refresh, 1);
    assert.strictEqual(calls.legal, 1, '로그인 경로로 넘어가 문서를 확인한다');
  } finally {
    server.close();
  }
});

test('--force는 세션이 살아 있어도 로그인을 다시 진행한다 (CLAW-213)', async () => {
  const { server, calls, port } = await startServer(200);
  try {
    const r = await runLogin(makeEnv(port, { accessToken: 'old-access', refreshToken: 'old-refresh' }), ['--force']);
    assert.doesNotMatch(r.stdout, /이미 로그인돼 있습니다/);
    assert.strictEqual(calls.refresh, 0, '--force는 세션을 확인하지 않는다');
    assert.strictEqual(calls.legal, 1);
  } finally {
    server.close();
  }
});

test('auth.json이 없으면 세션 확인 없이 로그인을 진행한다 (CLAW-213)', async () => {
  const { server, calls, port } = await startServer(200);
  try {
    const r = await runLogin(makeEnv(port, null));
    assert.doesNotMatch(r.stdout, /이미 로그인돼 있습니다/);
    assert.strictEqual(calls.refresh, 0);
    assert.strictEqual(calls.legal, 1);
  } finally {
    server.close();
  }
});
