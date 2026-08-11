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
const OVERLAY_EVENTS = path.join(__dirname, '..', 'client', 'overlay-events.js');
const SCHEDULED_SYNC = path.join(__dirname, '..', 'client', 'scheduled-sync.js');

function jwt(exp) {
  return `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;
}

function makeData(auth) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-sync-'));
  if (auth !== undefined) fs.writeFileSync(path.join(data, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth));
  return data;
}

function runSync(data, server, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SYNC], {
      env: { ...process.env, CLAWAD_DATA: data, CLAWAD_SERVER: server, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// 오버레이가 표시 사실을 남긴 뒤 직접 실행하는 수거 커맨드 (overlay-contract §3.3).
// 광고 표시 창구가 오버레이 하나뿐이므로(CLAW-134) sync와 원장을 다투는 상대는 이 프로세스다.
function runCollect(data) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OVERLAY_EVENTS, 'collect'], {
      env: { ...process.env, CLAWAD_DATA: data, CLAWAD_BUNDLES: '', CLAWAD_LEDGER: '', CLAWAD_OVERLAY_SPOOL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** 훅이 만든 활성 구간과 오버레이가 남긴 표시 사실. 둘이 겹쳐야 인정 노출이 된다. */
function stageOverlayImpression(data, serveToken, sessionId) {
  const now = Date.now();
  const startedAt = now - 5100;
  const key = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  const workFile = path.join(data, 'work-state', `${key}.json`);
  fs.mkdirSync(path.dirname(workFile), { recursive: true });
  fs.writeFileSync(workFile, JSON.stringify({
    version: 1, active: false, intervals: [{ startedAt: startedAt - 500, endedAt: now }], updatedAt: now,
  }));
  const spoolDir = path.join(data, 'overlay-events');
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.writeFileSync(path.join(spoolDir, `${crypto.randomBytes(16).toString('hex')}.json`), JSON.stringify({
    version: 1, serveToken, renderStarted: startedAt, displayStartedAt: startedAt, displayEndedAt: now,
  }));
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
    if (req.url === '/v1/rewards') {
      res.end(JSON.stringify({ verifyingPoints: 12, confirmedPoints: 34 }));
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
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(data, 'reward-summary.json'), 'utf8'))).filter(([key]) => ['verifyingPoints', 'confirmedPoints'].includes(key))),
    { verifyingPoints: 12, confirmedPoints: 34 },
  );
});

// 노출당 0.3P라 4건이 모여야 1P가 된다. 그 사이 화면 숫자가 멈춰 있지 않도록 서버가 캐리까지
// 담은 tenths를 주고, sync는 그대로 옮기기만 한다 — 클라이언트는 단가를 모른다 (CLAW-157).
test('서버가 준 적립 tenths를 그대로 저장한다 (CLAW-157)', async () => {
  const data = makeData({ accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'tenths-refresh' });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/ad-decision/prefetch-status') {
      return res.end(JSON.stringify({ unused: 0, limit: 0, needsRefill: false }));
    }
    if (req.url === '/v1/rewards') {
      return res.end(JSON.stringify({
        verifyingPoints: 0, confirmedPoints: 33, minimumRedemptionPoints: 1500, accruedPointsTenths: 336,
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSync(data, `http://127.0.0.1:${server.address().port}`);
    assert.strictEqual(result.status, 0, result.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(data, 'reward-summary.json'), 'utf8'));
    assert.strictEqual(summary.accruedPointsTenths, 336, '33.6P');
    // 정수부는 서버가 준 확정·검증 중 합과 맞아야 한다 — 어긋나면 없는 포인트를 보여주게 된다.
    assert.strictEqual(Math.floor(summary.accruedPointsTenths / 10),
      summary.confirmedPoints + summary.verifyingPoints);
  } finally {
    server.close();
  }
});

test('적립 tenths가 정수가 아니거나 음수면 저장하지 않는다 (CLAW-157)', async () => {
  for (const bad of [-1, 1.5, '336', null]) {
    const data = makeData({ accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'bad-tenths' });
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/machines') return res.end('{}');
      if (req.url === '/v1/ad-decision/prefetch-status') {
        return res.end(JSON.stringify({ unused: 0, limit: 0, needsRefill: false }));
      }
      if (req.url === '/v1/rewards') {
        return res.end(JSON.stringify({
          verifyingPoints: 0, confirmedPoints: 5, accruedPointsTenths: bad,
        }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await runSync(data, `http://127.0.0.1:${server.address().port}`);
      assert.strictEqual(result.status, 0, result.stderr);
      const summary = JSON.parse(fs.readFileSync(path.join(data, 'reward-summary.json'), 'utf8'));
      assert.ok(!('accruedPointsTenths' in summary), `거절해야 한다: ${JSON.stringify(bad)}`);
    } finally {
      server.close();
    }
  }
});

// 오버레이는 별도 프로그램이라 정책 파일·loadPolicy에 접근하지 않는다. 표시에 필요한 값만 캐시로 넘긴다.
test('오버레이 정책 캐시를 쓰고 금액 관련 정책은 넘기지 않는다 (CLAW-90)', async () => {
  const data = makeData({ accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'cache-refresh' });
  await withServer(200, async (server) => {
    const result = await runSync(data, server, { CLAWAD_WEB: 'https://clawad.whatsup.house/' });
    assert.strictEqual(result.status, 0, result.stderr);
  });
  const policy = require('../policy/policy').loadPolicy();
  const cache = JSON.parse(fs.readFileSync(path.join(data, 'overlay-policy.json'), 'utf8'));
  assert.strictEqual(cache.version, 1);
  assert.strictEqual(cache.rewardShopUrl, 'https://clawad.whatsup.house/',
    '리워드샵 주소는 오버레이 코드가 아니라 CLI의 로컬 계약으로 전달한다');
  assert.deepStrictEqual(cache.overlay, {
    adRotateMs: policy.overlay.adRotateMs,
    // 인정 구간 사이 간격 (CLAW-135). 오버레이가 이 값 없이는 간격을 추측하면 안 되므로 반드시 전달한다.
    adGapMs: policy.overlay.adGapMs,
    idleThresholdMs: policy.overlay.idleThresholdMs,
    maxWidthPx: policy.overlay.maxWidthPx,
  });
  assert.strictEqual(cache.impression.minViewMs, policy.impression.minViewMs);
  // 활동 상태 유효기간 (CLAW-142). 이 값이 없으면 오버레이가 좀비 active 세션을 걸러내지 못해
  // 표시와 인정의 판단이 어긋난다.
  assert.strictEqual(cache.activity.staleActiveMs, policy.activity.staleActiveMs);
  assert.ok(Number.isFinite(cache.updatedAt));
  // 단가·상한·배분율·CPM은 캐시에 없어야 한다 — 클라이언트는 금액을 다루지 않는다(rules §2).
  const serialized = JSON.stringify(cache);
  for (const forbidden of [
    'rewardPer', 'dailyReward', 'completionReward', 'minimumRedemption',
    'advertiser', 'Cpm', 'Limit', 'vatRate', 'PerThousand',
  ]) {
    assert.ok(!serialized.includes(forbidden), `정책 캐시에 ${forbidden}가 들어 있다`);
  }
  // 스풀 디렉터리가 비어 있어도 수거는 조용히 지나간다.
  assert.strictEqual(fs.existsSync(path.join(data, 'overlay-events')), false);
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

// 처방침·약관을 개정하면 서버는 refresh는 통과시키고 보호 엔드포인트에서 CONSENT_REQUIRED를
// 던진다(jwt-auth.guard). 이전에는 호출부가 일반 Error를 던져 SYNC_FAILED로 뭉개졌고, 사용자는
// 적립이 멈춘 이유를 알 수 없었다. 오버레이가 "재로그인 필요"를 표시하려면 이 코드가 필요하다.
test('방침 개정으로 재동의가 필요한 상태를 세션 만료와 구분한다', async () => {
  const valid = { accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'consent-refresh' };
  const data = makeData(valid);
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    // refresh는 동의 게이트를 타지 않는다 — 만료가 아니라 재동의 상황임을 재현하는 핵심이다.
    if (req.url === '/v1/auth/refresh') {
      res.statusCode = 200;
      res.end(JSON.stringify({ accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'rotated' }));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'CONSENT_REQUIRED' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runSync(data, origin);
    assert.strictEqual(result.status, 1);
    const state = JSON.parse(fs.readFileSync(path.join(data, 'sync-state.json'), 'utf8'));
    assert.strictEqual(state.lastError.code, 'CONSENT_REQUIRED');
    assert.match(state.lastError.message, /재동의/);
    // 토큰 값이 로그로 새지 않는지 (privacy-design §6.5)
    assert.doesNotMatch(result.stderr, /consent-refresh|rotated/);
  } finally {
    server.close();
  }
});

test('append 후 강제 종료 복구는 pending 해제 전에 소비 토큰을 캐시에서 제거한다', async () => {
  const machineId = '0123456789abcdef0123456789abcdef';
  const usedToken = 'crash-recovery-used-token';
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'crash-recovery-refresh',
  });
  const event = {
    serveToken: usedToken,
    sequence: 1,
    machineId,
    startedAt: Date.now() - 6000,
    endedAt: Date.now(),
    clientVersion: '0.1.0',
    synced: false,
  };
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId }));
  const ledger = `\uFEFF${JSON.stringify(event)}\n{broken-tail`;
  fs.writeFileSync(path.join(data, 'ledger.jsonl'), ledger);
  fs.writeFileSync(path.join(data, 'ledger-summary-pending.json'), JSON.stringify({ event, createdAt: Date.now() }));
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([
    { serveToken: usedToken, expiresAt: Date.now() + 60000, ad: { text: '소비됨', campaignType: 'PAID' } },
    { serveToken: 'unused-token', expiresAt: Date.now() + 60000, ad: { text: '미사용', campaignType: 'PAID' } },
  ]));

  const result = await runSync(data, 'http://127.0.0.1:1');
  assert.strictEqual(result.status, 1);
  assert.ok(!fs.existsSync(path.join(data, 'ledger-summary-pending.json')));
  const cached = JSON.parse(fs.readFileSync(path.join(data, 'bundles.json'), 'utf8'));
  assert.deepStrictEqual(cached.map((bundle) => bundle.serveToken), ['unused-token']);
  assert.strictEqual(fs.readFileSync(path.join(data, 'ledger.jsonl'), 'utf8'), ledger);
});

test('TEST 리허설 모드는 일반 번들을 폐기하고 명시적 TEST 결정만 캐시한다', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'test-rehearsal-refresh',
  });
  const machineId = '0123456789abcdef0123456789abcdef';
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId }));
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([{
    serveToken: 'cached-paid-token',
    expiresAt: Date.now() + 60000,
    ad: { text: '일반 광고', campaignType: 'PAID' },
  }]));

  let revoked = false;
  let rehearsalHeader;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/rewards') return res.end(JSON.stringify({ verifyingPoints: 0, confirmedPoints: 0 }));
    if (req.url === '/v1/ad-decision/prefetch-status') {
      return res.end(JSON.stringify({ unused: 1, limit: 1, needsRefill: false }));
    }
    if (req.url === '/v1/ad-decision/prefetched-tokens' && req.method === 'DELETE') {
      revoked = true;
      return res.end(JSON.stringify({ revoked: 1 }));
    }
    if (req.url === '/v1/ad-decision') {
      rehearsalHeader = req.headers['x-clawad-rehearsal-mode'];
      return res.end(JSON.stringify({
        serveToken: 'rehearsal-test-token',
        expiresAt: Date.now() + 60000,
        ad: { text: '리허설 광고', brand: '클로애드', label: '광고', campaignType: 'TEST' },
      }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSync(data, `http://127.0.0.1:${server.address().port}`, {
      CLAWAD_REHEARSAL_MODE: 'TEST',
    });
    assert.strictEqual(result.status, 0, result.stderr);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.strictEqual(revoked, true);
  assert.strictEqual(rehearsalHeader, 'TEST');
  const cached = JSON.parse(fs.readFileSync(path.join(data, 'bundles.json'), 'utf8'));
  assert.deepStrictEqual(cached.map((bundle) => bundle.ad.campaignType), ['TEST']);
});

// 토큰은 한 배치로 발급돼 만료도 동시에 온다. 서버가 개수만 보고 "충분"이라 답해도
// 곧 전부 죽으면 다음 sync까지 광고 공백이 생긴다 (CLAW-107).
test('개수가 충분해도 캐시가 곧 만료되면 미리 리필한다 (CLAW-107)', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'soon-expiring-refresh',
  });
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({
    machineId: '0123456789abcdef0123456789abcdef',
  }));
  // 아직 유효하지만 1분 뒤 만료된다 — 정책 리필 지평(10분) 안이다.
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([{
    serveToken: 'soon-expiring-token',
    expiresAt: Date.now() + 60000,
    ad: { text: '곧 만료되는 광고', brand: '클로애드', label: '광고', campaignType: 'PAID' },
  }]));

  let decisionCalls = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/rewards') return res.end(JSON.stringify({ verifyingPoints: 0, confirmedPoints: 0 }));
    if (req.url === '/v1/ad-decision/prefetch-status') {
      // 서버는 개수만 보고 "리필 불필요"라고 답한다.
      return res.end(JSON.stringify({ unused: 1, limit: 3, needsRefill: false }));
    }
    if (req.url === '/v1/ad-decision') {
      decisionCalls += 1;
      return res.end(JSON.stringify({
        serveToken: `fresh-token-${decisionCalls}`,
        expiresAt: Date.now() + 3600000,
        ad: { text: '새 광고', brand: '클로애드', label: '광고', campaignType: 'PAID' },
      }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSync(data, `http://127.0.0.1:${server.address().port}`);
    assert.strictEqual(result.status, 0, result.stderr);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.ok(decisionCalls > 0, '임박 만료면 서버가 리필 불필요라고 해도 새 토큰을 받아야 한다.');
  const cached = JSON.parse(fs.readFileSync(path.join(data, 'bundles.json'), 'utf8'));
  assert.ok(cached.length > 1, `캐시가 늘어야 한다 (현재 ${cached.length}개)`);
});

test('알 수 없는 리허설 모드는 네트워크 전에 fail-closed로 거부한다', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'invalid-rehearsal-refresh',
  });
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({
    machineId: '0123456789abcdef0123456789abcdef',
  }));
  const result = await runSync(data, 'http://127.0.0.1:1', { CLAWAD_REHEARSAL_MODE: 'PAID' });
  assert.strictEqual(result.status, 1);
  const state = JSON.parse(fs.readFileSync(path.join(data, 'sync-state.json'), 'utf8'));
  assert.strictEqual(state.lastError.code, 'INVALID_REHEARSAL_MODE');
});

test('pause 상태의 예약 실행은 네트워크 없이 안전하게 종료한다', async () => {
  const data = makeData({ accessToken: jwt(0), refreshToken: 'pause-secret' });
  fs.writeFileSync(path.join(data, 'paused'), new Date().toISOString());
  const result = await runSync(data, 'http://127.0.0.1:1');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /일시중지/);
  assert.doesNotMatch(result.stdout + result.stderr, /pause-secret|127\.0\.0\.1/);
});

test('서버 광고 긴급 중지는 번들만 원자적으로 비우고 로컬 원장을 보존한다', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'global-stop-refresh',
  });
  const machineId = '0123456789abcdef0123456789abcdef';
  const ledger = JSON.stringify({
    serveToken: 'already-uploaded',
    sequence: 1,
    machineId,
    startedAt: 1,
    endedAt: 6001,
    synced: true,
  }) + '\n';
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId }));
  fs.writeFileSync(path.join(data, 'ledger.jsonl'), ledger);
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([{
    serveToken: 'cached-before-stop',
    expiresAt: Date.now() + 60000,
    ad: { text: '중지 대상', brand: '테스트', campaignType: 'PAID' },
  }]));

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/rewards') {
      return res.end(JSON.stringify({ verifyingPoints: 0, confirmedPoints: 0 }));
    }
    if (req.url === '/v1/ad-decision/prefetch-status') {
      return res.end(JSON.stringify({ unused: 0, limit: 3, needsRefill: false, paused: true }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSync(data, `http://127.0.0.1:${server.address().port}`);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /광고 제공이 일시중지/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(data, 'bundles.json'), 'utf8')), []);
  assert.strictEqual(fs.readFileSync(path.join(data, 'ledger.jsonl'), 'utf8'), ledger);
});

test('캠페인 킬스위치는 해당 프리페치 번들만 제거하고 다른 광고와 원장을 보존한다', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'campaign-stop-refresh',
  });
  const machineId = '0123456789abcdef0123456789abcdef';
  const blockedCampaignId = '11111111-1111-4111-8111-111111111111';
  const allowedCampaignId = '22222222-2222-4222-8222-222222222222';
  const ledger = JSON.stringify({
    serveToken: 'preserved-ledger-token',
    sequence: 1,
    machineId,
    startedAt: 1,
    endedAt: 6001,
    synced: true,
  }) + '\n';
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId }));
  fs.writeFileSync(path.join(data, 'ledger.jsonl'), ledger);
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([
    {
      serveToken: 'blocked-cached-token',
      expiresAt: Date.now() + 60000,
      ad: { campaignId: blockedCampaignId, text: '중지 대상', brand: '테스트', campaignType: 'PAID' },
    },
    {
      serveToken: 'allowed-cached-token',
      expiresAt: Date.now() + 60000,
      ad: { campaignId: allowedCampaignId, text: '유지 대상', brand: '테스트', campaignType: 'PAID' },
    },
  ]));

  let campaignHeader;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/rewards') {
      return res.end(JSON.stringify({ verifyingPoints: 0, confirmedPoints: 0 }));
    }
    if (req.url === '/v1/ad-decision/prefetch-status') {
      campaignHeader = req.headers['x-clawad-campaign-ids'];
      return res.end(JSON.stringify({
        unused: 2,
        limit: 3,
        needsRefill: false,
        paused: false,
        blockedCampaignIds: [blockedCampaignId],
      }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSync(data, `http://127.0.0.1:${server.address().port}`);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /중지된 캠페인 광고 번들 1건/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const cached = JSON.parse(fs.readFileSync(path.join(data, 'bundles.json'), 'utf8'));
  assert.strictEqual(campaignHeader, `${blockedCampaignId},${allowedCampaignId}`);
  assert.deepStrictEqual(cached.map((bundle) => bundle.ad.campaignId), [allowedCampaignId]);
  assert.strictEqual(fs.readFileSync(path.join(data, 'ledger.jsonl'), 'utf8'), ledger);
});

test('sync 업로드 중 오버레이 수거가 append한 이벤트를 원장 재작성에서 보존한다', async () => {
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
    serveToken: 'overlay-token',
    expiresAt: Date.now() + 60000,
    minViewMs: 5000,
    ad: { text: '동시성 테스트', brand: '클로애드', campaignType: 'PAID' },
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

    stageOverlayImpression(data, 'overlay-token', 'sync-race');
    const collected = await runCollect(data);
    assert.strictEqual(collected.status, 0, collected.stderr);
    assert.match(collected.stdout, /인정 1건/, collected.stdout);

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
  assert.strictEqual(events.find((event) => event.serveToken === 'overlay-token').synced, false);
  assert.deepStrictEqual(events.map((event) => event.sequence).sort((a, b) => a - b), [1, 2]);
});

test('원장 손상 1줄이 업로드를 막지 않고 격리된다 (CLAW-177)', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'refresh',
  });
  const machineId = '0123456789abcdef0123456789abcdef';
  const event = (serveToken, sequence) => ({
    serveToken,
    sequence,
    machineId,
    startedAt: Date.now() - 10000,
    endedAt: Date.now() - 5000,
    clientVersion: '0.1.0',
    synced: false,
  });
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId }));
  // 수거가 appendFileSync 도중 강제 종료돼 불완전한 줄이 남은 상태를 재현한다.
  fs.writeFileSync(
    path.join(data, 'ledger.jsonl'),
    `${JSON.stringify(event('token-a', 1))}\n{"serveToken":"token-b","seq\n${JSON.stringify(event('token-c', 3))}\n`,
  );

  let uploaded = null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/events') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      await new Promise((resolve) => req.on('end', resolve));
      uploaded = JSON.parse(body);
      return res.end(JSON.stringify({ received: uploaded.length, accepted: uploaded.length, rejected: {} }));
    }
    if (req.url === '/v1/ad-decision/prefetch-status') {
      return res.end(JSON.stringify({ unused: 0, limit: 0, needsRefill: false }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const result = await runSync(data, `http://127.0.0.1:${server.address().port}`);
    assert.strictEqual(result.status, 0, result.stderr);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 손상 줄이 있어도 성한 이벤트는 전부 올라간다 — 전체가 빈 배열이 되면 여기서 0건이 된다.
  assert.ok(uploaded, '이벤트 업로드가 아예 일어나지 않았다');
  assert.deepStrictEqual(uploaded.map((e) => e.serveToken).sort(), ['token-a', 'token-c']);

  // 원장은 파싱된 이벤트만 남기고 둘 다 synced로 표시된다. 빈 파일이 되면 안 된다.
  const lines = fs.readFileSync(path.join(data, 'ledger.jsonl'), 'utf8').trim().split('\n');
  const events = lines.map((line) => JSON.parse(line));
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events.map((e) => e.synced), [true, true]);

  // 손상 줄은 버리지 않고 격리 파일에 원문 그대로 보관한다.
  const quarantined = fs.readFileSync(path.join(data, 'ledger.jsonl.corrupt'), 'utf8');
  assert.match(quarantined, /\{"serveToken":"token-b","seq$/m);
});

test('프리페치 중 소비된 토큰은 오래된 sync 스냅샷으로 부활하지 않는다', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'prefetch-race-refresh',
  });
  const machineId = '0123456789abcdef0123456789abcdef';
  const usedToken = 'prefetch-race-used-token';
  const newToken = 'prefetch-race-new-token';
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId }));
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([{
    serveToken: usedToken,
    expiresAt: Date.now() + 60000,
    minViewMs: 5000,
    ad: { text: '소비 예정', brand: '클로애드', campaignType: 'PAID' },
  }]));

  let decisionRequested;
  const requested = new Promise((resolve) => { decisionRequested = resolve; });
  let allowDecision;
  const allowed = new Promise((resolve) => { allowDecision = resolve; });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/rewards') return res.end(JSON.stringify({ verifyingPoints: 0, confirmedPoints: 0 }));
    if (req.url === '/v1/ad-decision/prefetch-status') {
      return res.end(JSON.stringify({ unused: 1, limit: 2, needsRefill: true }));
    }
    if (req.url === '/v1/ad-decision') {
      decisionRequested();
      await allowed;
      return res.end(JSON.stringify({
        serveToken: newToken,
        expiresAt: Date.now() + 60000,
        minViewMs: 5000,
        ad: { text: '신규 광고', brand: '클로애드', campaignType: 'PAID' },
      }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const syncResult = runSync(data, `http://127.0.0.1:${server.address().port}`);
    await requested;
    // sync가 자기 주기의 수거를 이미 끝낸 뒤에 표시 사실을 남긴다 — 광고 결정을 기다리는
    // 동안 오버레이가 토큰을 소비하는 상황을 그대로 만든다.
    stageOverlayImpression(data, usedToken, 'prefetch-race');
    const collected = await runCollect(data);
    assert.strictEqual(collected.status, 0, collected.stderr);
    assert.match(collected.stdout, /인정 1건/, collected.stdout);
    allowDecision();
    const result = await syncResult;
    assert.strictEqual(result.status, 0, result.stderr);
  } finally {
    allowDecision();
    await new Promise((resolve) => server.close(resolve));
  }

  const events = fs.readFileSync(path.join(data, 'ledger.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepStrictEqual(events.map((event) => event.serveToken), [usedToken]);
  const cached = JSON.parse(fs.readFileSync(path.join(data, 'bundles.json'), 'utf8'));
  assert.deepStrictEqual(cached.map((bundle) => bundle.serveToken), [newToken]);
});

// CLAW-164: 서버는 거절 사유별 건수를 응답에 담아 보내는데 지금까지 콘솔에만 찍었다.
// sync는 5분 주기 예약 작업이라 stdout을 볼 방법이 없어 "적립이 왜 안 늘지"를 추측으로만
// 다뤄야 했다. 파일로 남겨 `clawad status`가 읽게 한다.
test('업로드 결과의 거절 사유를 파일로 남긴다 (CLAW-164)', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'outcome-refresh',
  });
  const machineId = '0123456789abcdef0123456789abcdef';
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId }));
  fs.writeFileSync(path.join(data, 'ledger.jsonl'), `${JSON.stringify({
    serveToken: 'outcome-token',
    sequence: 1,
    machineId,
    startedAt: Date.now() - 20000,
    endedAt: Date.now() - 8000,
    clientVersion: '0.1.16',
    synced: false,
  })}\n`);

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/events') {
      return res.end(JSON.stringify({ received: 1, accepted: 0, rejected: { BELOW_MIN_VIEW: 1 } }));
    }
    if (req.url === '/v1/ad-decision/prefetch-status') {
      return res.end(JSON.stringify({
        unused: 0, limit: 40, needsRefill: false, paused: false, blockedCampaignIds: [],
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSync(data, `http://127.0.0.1:${server.address().port}`);
    assert.strictEqual(result.status, 0, result.stderr);

    const outcomes = JSON.parse(fs.readFileSync(path.join(data, 'event-outcomes.json'), 'utf8'));
    assert.strictEqual(outcomes.version, 1);
    assert.strictEqual(outcomes.accepted, 0);
    // 사유별 건수가 남아야 원인을 좁힐 수 있다. 총계만으로는 무엇을 고칠지 알 수 없다.
    assert.deepStrictEqual(outcomes.rejected, { BELOW_MIN_VIEW: 1 });
    assert.match(outcomes.day, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    server.close();
  }
});

// CLAW-150: 일일 상한에 도달하면 서버는 새 토큰을 안 주지만 이미 발급된 토큰은 TTL이 남는다.
// 그대로 두면 사용자는 적립이 0인 광고를 계속 보고 서버는 그 노출을 전부 거절한다.
test('일일 상한에 도달하면 번들을 비우고 미사용 토큰을 반납한다 (CLAW-150)', async () => {
  const data = makeData({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: 'cap-refresh',
  });
  const machineId = '0123456789abcdef0123456789abcdef';
  fs.writeFileSync(path.join(data, 'machine.json'), JSON.stringify({ machineId }));
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([{
    serveToken: 'cap-token',
    expiresAt: Date.now() + 3600000,
    ad: { text: '광고 문구', campaignType: 'PAID' },
  }]));

  let revoked = false;
  const resetsAt = '2026-08-01T00:00:00.000Z';
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/machines') return res.end('{}');
    if (req.url === '/v1/rewards') {
      return res.end(JSON.stringify({ verifyingPoints: 150, confirmedPoints: 2000, minimumRedemptionPoints: 1500 }));
    }
    if (req.url === '/v1/ad-decision/prefetch-status') {
      return res.end(JSON.stringify({
        unused: 1, limit: 40, needsRefill: false, paused: false, blockedCampaignIds: [],
        dailyCapReached: true, dailyCapResetsAt: resetsAt,
      }));
    }
    if (req.url === '/v1/ad-decision/prefetched-tokens' && req.method === 'DELETE') {
      revoked = true;
      return res.end(JSON.stringify({ revoked: 1 }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSync(data, `http://127.0.0.1:${server.address().port}`);
    assert.strictEqual(result.status, 0, result.stderr);

    // 적립 0인 노출을 만들지 않도록 남은 재고를 비운다.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(data, 'bundles.json'), 'utf8')), []);
    // 서버 예약도 함께 푼다 — TTL 만료를 기다리면 그동안 재고가 묶인다.
    assert.ok(revoked, '미사용 토큰을 반납해야 한다');

    // 오버레이가 안내 문구를 띄울 수 있도록 상태와 수치가 한 파일에 함께 있어야 한다.
    const summary = JSON.parse(fs.readFileSync(path.join(data, 'reward-summary.json'), 'utf8'));
    assert.strictEqual(summary.dailyCapReached, true);
    assert.strictEqual(summary.dailyCapResetsAt, resetsAt);
    assert.strictEqual(summary.verifyingPoints, 150);
    assert.strictEqual(summary.confirmedPoints, 2000);
    assert.strictEqual(summary.minimumRedemptionPoints, 1500,
      '교환 기준은 서버가 준다 — 오버레이가 하드코딩하지 않는다');
    // 구 서버는 accruedPointsTenths를 주지 않는다. 없는 값을 만들어 쓰지 않는다 (CLAW-157).
    assert.ok(!('accruedPointsTenths' in summary),
      '서버가 주지 않은 적립 소수값을 클라이언트가 지어내면 안 된다');

    // 오버레이가 정한 스키마 (계약 §2.3). 형태를 바꾸면 안내 문구가 안 뜬다.
    const inventory = JSON.parse(fs.readFileSync(path.join(data, 'ad-inventory.json'), 'utf8'));
    assert.deepStrictEqual(inventory, { version: 1, exhausted: true });
  } finally {
    server.close();
  }
});
