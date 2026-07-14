'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const SYNC = path.join(__dirname, '..', 'client', 'sync.js');
const SCHEDULED_SYNC = path.join(__dirname, '..', 'client', 'scheduled-sync.js');

function jwt(exp) {
  return `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;
}

function makeData(auth) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-sync-'));
  if (auth !== undefined) fs.writeFileSync(path.join(data, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth));
  return data;
}

function runSync(data, server) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SYNC], {
      env: { ...process.env, CLAWAD_DATA: data, CLAWAD_SERVER: server },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function runScheduledSync(data) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCHEDULED_SYNC, data], {
      env: { ...process.env, CLAWAD_DATA: '', CLAWAD_SERVER: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withServer(refreshStatus, fn) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/auth/refresh') {
      res.statusCode = refreshStatus;
      res.end(refreshStatus === 200
        ? JSON.stringify({ accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'rotated-refresh' })
        : JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.url === '/v1/machines') {
      res.statusCode = 201;
      res.end('{}');
      return;
    }
    if (req.url === '/v1/ad-decision/prefetch-status') {
      res.end(JSON.stringify({ unused: 0, limit: 0, needsRefill: false }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('만료 직전 access token을 자동 회전하고 auth.json을 갱신한다', async () => {
  const old = { accessToken: jwt(Math.floor(Date.now() / 1000) - 1), refreshToken: 'old-refresh' };
  const data = makeData(old);
  await withServer(200, async (server) => {
    const result = await runSync(data, server);
    assert.strictEqual(result.status, 0, result.stderr);
  });
  const auth = JSON.parse(fs.readFileSync(path.join(data, 'auth.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(data, 'sync-state.json'), 'utf8'));
  assert.strictEqual(auth.refreshToken, 'rotated-refresh');
  assert.ok(auth.refreshedAt);
  assert.ok(state.lastSuccessAt);
  assert.ok(!fs.existsSync(path.join(data, 'sync.lock')));
});

test('예약 실행 진입점은 설치 시 저장한 서버 주소를 복원한다', async () => {
  const data = makeData({ accessToken: jwt(0), refreshToken: 'scheduled-refresh' });
  await withServer(200, async (server) => {
    fs.writeFileSync(path.join(data, 'sync-schedule.json'), JSON.stringify({ server }));
    const result = await runScheduledSync(data);
    assert.strictEqual(result.status, 0, result.stderr);
  });
  const auth = JSON.parse(fs.readFileSync(path.join(data, 'auth.json'), 'utf8'));
  assert.strictEqual(auth.refreshToken, 'rotated-refresh');
});

test('활성 잠금이 있으면 토큰·원장을 수정하지 않고 종료한다', async () => {
  const auth = { accessToken: jwt(0), refreshToken: 'unchanged' };
  const data = makeData(auth);
  fs.writeFileSync(path.join(data, 'sync.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const before = fs.readFileSync(path.join(data, 'auth.json'), 'utf8');
  const result = await runSync(data, 'http://127.0.0.1:1');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /다른 sync가 실행 중/);
  assert.strictEqual(fs.readFileSync(path.join(data, 'auth.json'), 'utf8'), before);
});

for (const [name, auth, code] of [
  ['누락', undefined, 'LOCAL_AUTH_MISSING'],
  ['손상', '{broken', 'LOCAL_AUTH_INVALID'],
]) {
  test(`로컬 auth 파일 ${name}을 구분해 안내한다`, async () => {
    const data = makeData(auth);
    const result = await runSync(data, 'http://127.0.0.1:1');
    assert.strictEqual(result.status, 1);
    const state = JSON.parse(fs.readFileSync(path.join(data, 'sync-state.json'), 'utf8'));
    assert.strictEqual(state.lastError.code, code);
  });
}

test('서버 세션 소실과 네트워크 장애를 구분한다', async () => {
  const expired = { accessToken: jwt(0), refreshToken: 'expired-refresh' };
  const sessionData = makeData(expired);
  await withServer(401, async (server) => {
    const result = await runSync(sessionData, server);
    assert.strictEqual(result.status, 1);
  });
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(sessionData, 'sync-state.json'), 'utf8')).lastError.code,
    'SESSION_EXPIRED',
  );

  const networkData = makeData(expired);
  const ledger = '{"sequence":1,"synced":false}\n';
  const bundles = '[{"serveToken":"local-only","expiresAt":9999999999999}]\n';
  fs.writeFileSync(path.join(networkData, 'ledger.jsonl'), ledger);
  fs.writeFileSync(path.join(networkData, 'bundles.json'), bundles);
  const result = await runSync(networkData, 'http://127.0.0.1:1');
  assert.strictEqual(result.status, 1);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(networkData, 'sync-state.json'), 'utf8')).lastError.code,
    'NETWORK_UNAVAILABLE',
  );
  assert.doesNotMatch(result.stderr, /expired-refresh|127\.0\.0\.1/);
  assert.strictEqual(fs.readFileSync(path.join(networkData, 'ledger.jsonl'), 'utf8'), ledger);
  assert.strictEqual(fs.readFileSync(path.join(networkData, 'bundles.json'), 'utf8'), bundles);
});

test('pause 상태의 예약 실행은 네트워크 없이 안전하게 종료한다', async () => {
  const data = makeData({ accessToken: jwt(0), refreshToken: 'pause-secret' });
  fs.writeFileSync(path.join(data, 'paused'), new Date().toISOString());
  const result = await runSync(data, 'http://127.0.0.1:1');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /일시중지/);
  assert.doesNotMatch(result.stdout + result.stderr, /pause-secret|127\.0\.0\.1/);
});
