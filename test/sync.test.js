'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const SYNC = path.join(__dirname, '..', 'client', 'sync.js');
const STATUSLINE = path.join(__dirname, '..', 'client', 'statusline.js');
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

function runStatusline(data, sessionId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STATUSLINE], {
      env: { ...process.env, CLAWAD_DATA: data },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify({ session_id: sessionId }));
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

test('sync 업로드 중 statusLine이 append한 이벤트를 원장 재작성에서 보존한다', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'refresh',
  });
  const firstEvent = {
    serveToken: 'uploading-token',
    sequence: 1,
    machineId: '0123456789abcdef0123456789abcdef',
    startedAt: Date.now() - 10000,
    endedAt: Date.now() - 5000,
    clientVersion: '0.1.0',
    synced: false,
  };
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId: firstEvent.machineId }));
  fs.writeFileSync(path.join(data, 'ledger.jsonl'), JSON.stringify(firstEvent) + '\n');
  fs.writeFileSync(path.join(data, 'ledger-summary.json'), JSON.stringify({
    version: 1, totalImpressions: 1, today: new Date(firstEvent.startedAt).toISOString().slice(0, 10),
    todayImpressions: 1, nextSequence: 1, updatedAt: Date.now(),
  }));
  fs.writeFileSync(path.join(data, 'sequence.json'), JSON.stringify({ nextSequence: 1 }));
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([{
    serveToken: 'statusline-token',
    expiresAt: Date.now() + 60000,
    minViewMs: 5000,
    ad: { text: '동시성 테스트', brand: '클로애드', campaignType: 'TEST' },
  }]));

  let eventsReceived;
  const received = new Promise((resolve) => { eventsReceived = resolve; });
  let allowResponse;
  const responseAllowed = new Promise((resolve) => { allowResponse = resolve; });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/events') {
      req.resume();
      await new Promise((resolve) => req.on('end', resolve));
      eventsReceived();
      await responseAllowed;
      return res.end(JSON.stringify({ received: 1, accepted: 1, rejected: {} }));
    }
    if (req.url === '/v1/ad-decision/prefetch-status') {
      return res.end(JSON.stringify({ unused: 0, limit: 0, needsRefill: false }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const syncResult = runSync(data, `http://127.0.0.1:${server.address().port}`);
    await received;

    assert.strictEqual((await runStatusline(data, 'sync-race')).status, 0);
    const key = crypto.createHash('sha256').update('sync-race').digest('hex').slice(0, 32);
    const stateFile = path.join(data, 'session-state', `${key}.json`);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.shownAt -= 5100;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.strictEqual((await runStatusline(data, 'sync-race')).status, 0);

    allowResponse();
    const result = await syncResult;
    assert.strictEqual(result.status, 0, result.stderr);
  } finally {
    allowResponse();
    await new Promise((resolve) => server.close(resolve));
  }

  const events = fs.readFileSync(path.join(data, 'ledger.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events.find((event) => event.serveToken === 'uploading-token').synced, true);
  assert.strictEqual(events.find((event) => event.serveToken === 'statusline-token').synced, false);
  assert.deepStrictEqual(events.map((event) => event.sequence).sort((a, b) => a - b), [1, 2]);
});
