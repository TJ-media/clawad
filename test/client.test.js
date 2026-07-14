'use strict';
// statusline.js 스모크 (CLAW-24) — 캐시 기반 렌더링, viewability, 사실만 기록, 견고성.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STATUSLINE = path.join(__dirname, '..', 'client', 'statusline.js');
const MIN_VIEW_MS = require('../policy/policy').loadPolicy().impression.minViewMs;

/** 서버가 발급했을 법한 번들. 클라이언트는 토큰을 만들 수 없으므로 여기서는 문자열로 흉내낸다. */
function makeBundle(overrides = {}) {
  return {
    serveToken: `payload.${crypto.randomBytes(8).toString('hex')}`,
    expiresAt: Date.now() + 10 * 60 * 1000,
    ad: {
      campaignId: 'camp-1',
      creativeId: 'cr-1',
      text: '테스트 광고',
      brand: '테스트',
      label: '광고',
      campaignType: 'PAID',
    },
    minViewMs: MIN_VIEW_MS,
    ...overrides,
  };
}

function makeEnv(bundles = [makeBundle()]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-test-'));
  fs.writeFileSync(path.join(dir, 'bundles.json'), JSON.stringify(bundles));
  return { ...process.env, CLAWAD_DATA: dir, CLAWAD_BUNDLES: path.join(dir, 'bundles.json') };
}

function run(env, input) {
  return spawnSync('node', [STATUSLINE], { input, env, encoding: 'utf8' });
}

function runAsync(env, input) {
  return new Promise((resolve) => {
    const child = spawn('node', [STATUSLINE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

const sessionInput = (sessionId = 'session-a') => JSON.stringify({ session_id: sessionId });
const sessionKey = (sessionId) => crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);

const ledgerOf = (env) => path.join(env.CLAWAD_DATA, 'ledger.jsonl');
const stateOf = (env, sessionId = 'session-a') =>
  path.join(env.CLAWAD_DATA, 'session-state', `${sessionKey(sessionId)}.json`);

function readEvents(env) {
  if (!fs.existsSync(ledgerOf(env))) return [];
  return fs
    .readFileSync(ledgerOf(env), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** 표시 시작 시각을 과거로 돌려 viewability 경과를 흉내낸다. */
function backdate(env, ms, sessionId = 'session-a') {
  const file = stateOf(env, sessionId);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.shownAt -= ms;
  fs.writeFileSync(file, JSON.stringify(state));
}

test('캐시된 광고 한 줄을 [광고] 표기와 함께 출력하고 exit 0', () => {
  const env = makeEnv();
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\[광고\]/);
  assert.match(r.stdout, /테스트 광고/);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1, '출력은 정확히 한 줄이어야 한다');
});

test('깨진 stdin에도 광고를 출력하고 exit 0', () => {
  const env = makeEnv();
  const r = run(env, 'not-json{{{');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\[광고\]/);
});

test('빈 stdin에도 광고를 출력하고 exit 0', () => {
  const env = makeEnv();
  const r = run(env, '');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\[광고\]/);
});

test('캐시가 비어도 상태줄을 깨뜨리지 않는다', () => {
  const env = makeEnv([]);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stdout, /광고 준비 중/);
});

test('캐시가 비어도 머신 ID를 만든다 — sync 부트스트랩 (회귀)', () => {
  // statusline이 캐시 없음으로 조기 종료하면서 machine.json을 만들지 않으면,
  // sync가 기기를 등록하지 못해 신규 설치가 영영 시작되지 않는다.
  const env = makeEnv([]);
  run(env, sessionInput());
  const machineFile = path.join(env.CLAWAD_DATA, 'machine.json');
  assert.ok(fs.existsSync(machineFile), '캐시가 비어도 machine.json이 생성돼야 한다');
  assert.match(JSON.parse(fs.readFileSync(machineFile, 'utf8')).machineId, /^[0-9a-f]{32}$/);
});

test('만료된 번들은 사용하지 않는다', () => {
  const env = makeEnv([makeBundle({ expiresAt: Date.now() - 1000 })]);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /광고 준비 중/);
  assert.strictEqual(readEvents(env).length, 0, '만료 토큰으로 이벤트를 만들면 안 된다');
});

test('viewability 미만 노출은 이벤트를 만들지 않는다', () => {
  const env = makeEnv();
  run(env, sessionInput());
  assert.strictEqual(readEvents(env).length, 0);
});

test('viewability 이상 연속 표시는 정확히 1회만 집계한다', () => {
  const env = makeEnv();
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());
  assert.strictEqual(readEvents(env).length, 1);

  // 같은 슬롯을 다시 그려도 중복 집계하지 않는다.
  run(env, sessionInput());
  assert.strictEqual(readEvents(env).length, 1);
});

test('이벤트는 사실만 담는다 — 금액 필드도 멱등 키도 없다', () => {
  const env = makeEnv();
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());

  const [event] = readEvents(env);
  assert.deepStrictEqual(
    Object.keys(event).sort(),
    ['clientVersion', 'endedAt', 'machineId', 'sequence', 'serveToken', 'startedAt', 'synced'].sort()
  );

  for (const forbidden of ['gross', 'userShare', 'rewardAmount', 'price', 'impressionId', 'idempotencyKey', 'hmac']) {
    assert.ok(!(forbidden in event), `이벤트에 ${forbidden} 필드가 있으면 안 된다`);
  }
  assert.ok(event.endedAt - event.startedAt >= MIN_VIEW_MS);
  assert.strictEqual(typeof event.sequence, 'number');
});

test('sequence는 단조 증가한다', () => {
  const env = makeEnv([makeBundle(), makeBundle()]);
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());
  backdate(env, 20000); // 로테이션 주기 경과
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());

  const events = readEvents(env);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(
    events.map((e) => e.sequence),
    [1, 2]
  );
});

test('machineId는 32자리 hex 가명값이며 하드웨어 식별자가 아니다', () => {
  const env = makeEnv();
  run(env, sessionInput());
  const { machineId } = JSON.parse(fs.readFileSync(path.join(env.CLAWAD_DATA, 'machine.json'), 'utf8'));
  assert.match(machineId, /^[0-9a-f]{32}$/);
});

test('일시중지 상태에서는 광고를 표시하지 않고 이벤트도 만들지 않는다', () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'paused'), 'x');
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /일시중지/);
  assert.doesNotMatch(r.stdout, /\[광고\]/);
  assert.strictEqual(readEvents(env).length, 0);
});

test('화면에 원화를 표시하지 않는다 (단위는 P)', () => {
  const env = makeEnv();
  run(env, sessionInput());
  const r = run(env, sessionInput());
  assert.doesNotMatch(r.stdout, /원|₩|KRW/);
  assert.match(r.stdout, /예상 오늘 .*P/);
});

test('핫패스에 네트워크 호출 코드가 없다', () => {
  const src = fs.readFileSync(STATUSLINE, 'utf8');
  for (const forbidden of ['fetch(', 'http.request', 'https.request', 'net.connect']) {
    assert.ok(!src.includes(forbidden), `statusline.js에 ${forbidden}가 있으면 안 된다`);
  }
});

test('session_id가 없거나 손상되면 표시만 하고 상태·원장을 갱신하지 않는다', () => {
  for (const input of ['', '{}', '\uFEFFnot-json']) {
    const env = makeEnv();
    const result = run(env, input);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim().split('\n').length, 1);
    assert.strictEqual(readEvents(env).length, 0);
    assert.ok(!fs.existsSync(path.join(env.CLAWAD_DATA, 'session-state')));
  }
});

test('두 Claude 세션은 서로 다른 번들과 타이머를 사용한다', () => {
  const env = makeEnv([makeBundle(), makeBundle()]);
  run(env, sessionInput('session-a'));
  run(env, sessionInput('session-b'));

  const stateA = JSON.parse(fs.readFileSync(stateOf(env, 'session-a'), 'utf8'));
  const stateB = JSON.parse(fs.readFileSync(stateOf(env, 'session-b'), 'utf8'));
  assert.notStrictEqual(stateA.serveToken, stateB.serveToken);

  backdate(env, MIN_VIEW_MS + 100, 'session-a');
  run(env, sessionInput('session-b'));
  assert.strictEqual(readEvents(env).length, 0, '다른 세션이 session-a 타이머를 완료하면 안 된다');
});

test('병렬 세션 완료에서도 원장 행과 machine sequence가 유실·중복되지 않는다', async () => {
  const env = makeEnv([makeBundle(), makeBundle()]);
  run(env, sessionInput('parallel-a'));
  run(env, sessionInput('parallel-b'));
  backdate(env, MIN_VIEW_MS + 100, 'parallel-a');
  backdate(env, MIN_VIEW_MS + 100, 'parallel-b');

  const results = await Promise.all([
    runAsync(env, sessionInput('parallel-a')),
    runAsync(env, sessionInput('parallel-b')),
  ]);
  for (const result of results) assert.strictEqual(result.status, 0, result.stderr);

  const events = readEvents(env);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(new Set(events.map((event) => event.serveToken)).size, 2);
  assert.deepStrictEqual(events.map((event) => event.sequence).sort((a, b) => a - b), [1, 2]);
});

test('한 세션 상태가 손상돼도 다른 세션 상태와 노출은 유지된다', () => {
  const env = makeEnv([makeBundle(), makeBundle()]);
  run(env, sessionInput('healthy'));
  run(env, sessionInput('broken'));
  const healthyBefore = JSON.parse(fs.readFileSync(stateOf(env, 'healthy'), 'utf8'));
  fs.writeFileSync(stateOf(env, 'broken'), '{broken');

  backdate(env, MIN_VIEW_MS + 100, 'healthy');
  run(env, sessionInput('healthy'));
  assert.strictEqual(readEvents(env).length, 1);
  const healthyAfter = JSON.parse(fs.readFileSync(stateOf(env, 'healthy'), 'utf8'));
  assert.strictEqual(healthyAfter.serveToken, healthyBefore.serveToken);

  run(env, sessionInput('broken'));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(stateOf(env, 'broken'), 'utf8')));
  assert.strictEqual(readEvents(env).length, 1);
});

test('오래된 세션 상태는 다음 실행에서 정리된다', () => {
  const env = makeEnv([makeBundle(), makeBundle()]);
  run(env, sessionInput('stale'));
  const staleFile = stateOf(env, 'stale');
  const stale = JSON.parse(fs.readFileSync(staleFile, 'utf8'));
  stale.updatedAt = Date.now() - 25 * 60 * 60 * 1000;
  fs.writeFileSync(staleFile, JSON.stringify(stale));

  run(env, sessionInput('active'));
  assert.ok(!fs.existsSync(staleFile));
  assert.ok(fs.existsSync(stateOf(env, 'active')));
});

test('핫패스가 서비스 비밀 키나 HMAC을 만들지 않는다', () => {
  const src = fs.readFileSync(STATUSLINE, 'utf8');
  assert.ok(!src.includes('createHmac'), '클라이언트는 HMAC을 만들지 않는다 (rules §10)');
  assert.ok(!/SECRET|_secret/.test(src), '클라이언트는 서비스 비밀 키를 보유하지 않는다');
});

test('핫패스가 수집 금지 데이터에 접근하지 않는다', () => {
  const src = fs.readFileSync(STATUSLINE, 'utf8');
  // stdin은 읽되 세션 필드를 참조하지 않는다. 환경변수는 데이터 경로 지정용만 허용.
  for (const forbidden of ['process.cwd', 'session.', 'transcript', 'os.hostname', 'networkInterfaces']) {
    assert.ok(!src.includes(forbidden), `statusline.js가 ${forbidden}에 접근하면 안 된다`);
  }
});
