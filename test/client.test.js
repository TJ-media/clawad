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
const ROTATE_MS = require('../policy/policy').loadPolicy().statusLine.adRotateMs;

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
    clickUrl: 'https://click.example.test/v1/click/signed-token',
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
const workStateOf = (env, sessionId = 'session-a') =>
  path.join(env.CLAWAD_DATA, 'work-state', `${sessionKey(sessionId)}.json`);

function activateWork(env, sessionId = 'session-a') {
  const file = workStateOf(env, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1, active: true, startedAt: Date.now() - MIN_VIEW_MS - 100, intervals: [], updatedAt: Date.now(),
  }));
}

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

test('긴 원장이 있어도 statusLine은 요약만 읽어 빠르게 표시한다', () => {
  const env = makeEnv();
  const now = Date.now();
  fs.writeFileSync(ledgerOf(env), '{"sequence":1,"startedAt":0}\n'.repeat(20000));
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'ledger-summary.json'), JSON.stringify({
    version: 1,
    totalImpressions: 20000,
    today: new Date(now).toISOString().slice(0, 10),
    todayImpressions: 7,
    nextSequence: 20000,
    updatedAt: now,
  }));
  activateWork(env);
  const started = Date.now();
  const result = run(env, sessionInput());
  assert.strictEqual(result.status, 0);
  assert.ok(Date.now() - started < 1000);
  assert.match(result.stdout, /6,000P/);
});

test('캐시된 광고 한 줄을 [광고] 표기와 함께 출력하고 exit 0', () => {
  const env = makeEnv();
  activateWork(env);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\[광고\]/);
  assert.match(r.stdout, /테스트 광고/);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1, '출력은 정확히 한 줄이어야 한다');
});

test('지원 터미널에서는 광고 문구에만 안전한 OSC 8 클릭 링크를 넣는다', () => {
  const env = { ...makeEnv(), WT_SESSION: 'test', TERM: 'xterm-256color' };
  activateWork(env);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\x1b\]8;;https:\/\/click\.example\.test\/v1\/click\/signed-token\x1b\\/);
  assert.ok(!r.stdout.includes('payload.'), 'serveToken은 출력 URL에 포함하지 않는다');
});

test('제어문자가 섞인 클릭 URL은 직접 실행에서도 OSC 8 링크로 만들지 않는다', () => {
  const env = { ...makeEnv([makeBundle({ clickUrl: 'https://click.example.test/path\nforged' })]), WT_SESSION: 'test' };
  activateWork(env);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /\x1b\]8;;/);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1);
});

test('SSH·tmux에서는 OSC 8 링크 없이 일반 한 줄로 폴백한다', () => {
  const env = { ...makeEnv(), WT_SESSION: 'test', SSH_CONNECTION: 'host 1 host 2' };
  activateWork(env);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /\x1b\]8;;/);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1);
});

test('광고 문자열의 제어문자는 status line에 전달하지 않는다', () => {
  const env = makeEnv([makeBundle({ ad: { campaignId: 'camp', creativeId: 'creative', text: '정상\n\x1b]8;;https://evil.example\x07문구', brand: '\x1b[31m브랜드', label: '광고', campaignType: 'PAID' } })]);
  activateWork(env);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /evil\.example|\x1b\]8;;https:\/\/evil/);
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
  assert.match(r.stdout, /로그인 필요/);
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
  assert.match(r.stdout, /로그인 필요/);
  assert.strictEqual(readEvents(env).length, 0, '만료 토큰으로 이벤트를 만들면 안 된다');
});

test('viewability 미만 노출은 이벤트를 만들지 않는다', () => {
  const env = makeEnv();
  run(env, sessionInput());
  assert.strictEqual(readEvents(env).length, 0);
});

test('viewability 이상 연속 표시는 정확히 1회만 집계한다', () => {
  const env = makeEnv();
  activateWork(env);
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());
  assert.strictEqual(readEvents(env).length, 1);

  // 같은 슬롯을 다시 그려도 중복 집계하지 않는다.
  run(env, sessionInput());
  assert.strictEqual(readEvents(env).length, 1);
});

for (const campaignType of ['HOUSE', 'TEST']) {
  test(`${campaignType} 광고도 [광고]로 표시하고 5초 사실 노출을 원장에 기록한다`, () => {
    const bundle = makeBundle();
    bundle.ad.campaignType = campaignType;
    const env = makeEnv([bundle]);
    activateWork(env);
    assert.match(run(env, sessionInput()).stdout, /\[광고\]/);
    backdate(env, MIN_VIEW_MS + 100);
    assert.match(run(env, sessionInput()).stdout, /\[광고\]/);

    const events = readEvents(env);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].serveToken, bundle.serveToken);
    assert.ok(!('campaignType' in events[0]), '캠페인 유형 판정은 서명된 serveToken으로 서버가 수행한다');
  });
}

test('단일 광고는 소비 후 회전·오프라인·재시작에도 serveToken을 재사용하지 않는다', () => {
  const bundle = makeBundle();
  const env = makeEnv([bundle]);
  activateWork(env);
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());

  assert.strictEqual(readEvents(env).length, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(env.CLAWAD_BUNDLES, 'utf8')), []);

  // sync 없이 회전 주기가 지나고 새 프로세스로 다시 실행돼도 같은 토큰은 기록하지 않는다.
  backdate(env, 20000);
  run(env, sessionInput());
  run(env, sessionInput('restarted-session'));
  assert.strictEqual(readEvents(env).length, 1);
  assert.strictEqual(readEvents(env)[0].serveToken, bundle.serveToken);
});

test('여러 광고가 순환해도 이미 소비한 serveToken으로 돌아가지 않는다', () => {
  const bundles = [makeBundle(), makeBundle()];
  const env = makeEnv(bundles);
  activateWork(env);
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());

  // 집계 후에도 로테이션 주기를 채우기 전에는 같은 광고를 붙잡고 있다.
  backdate(env, ROTATE_MS);
  activateWork(env);
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());

  const events = readEvents(env);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(new Set(events.map((event) => event.serveToken)).size, 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(env.CLAWAD_BUNDLES, 'utf8')), []);

  run(env, sessionInput());
  assert.strictEqual(readEvents(env).length, 2);
});

test('같은 단일 광고의 병렬 완료 경쟁에서도 원장에는 한 번만 append한다', async () => {
  const env = makeEnv();
  activateWork(env, 'parallel-single');
  run(env, sessionInput('parallel-single'));
  backdate(env, MIN_VIEW_MS + 100, 'parallel-single');

  const results = await Promise.all([
    runAsync(env, sessionInput('parallel-single')),
    runAsync(env, sessionInput('parallel-single')),
  ]);
  for (const result of results) assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readEvents(env).length, 1);
});

test('이벤트는 사실만 담는다 — 금액 필드도 멱등 키도 없다', () => {
  const env = makeEnv();
  activateWork(env);
  run(env, sessionInput());
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());

  const [event] = readEvents(env);
  assert.deepStrictEqual(
    Object.keys(event).sort(),
    ['clientVersion', 'endedAt', 'machineId', 'renderStarted', 'sequence', 'serveToken', 'startedAt', 'synced'].sort()
  );

  for (const forbidden of ['gross', 'userShare', 'rewardAmount', 'price', 'impressionId', 'idempotencyKey', 'hmac']) {
    assert.ok(!(forbidden in event), `이벤트에 ${forbidden} 필드가 있으면 안 된다`);
  }
  assert.ok(event.endedAt - event.startedAt >= MIN_VIEW_MS);
  assert.strictEqual(typeof event.sequence, 'number');
  // 표시 시작(renderStarted)은 활성 유효 구간 시작(startedAt) 이하다 (CLAW-71).
  assert.strictEqual(typeof event.renderStarted, 'number');
  assert.ok(event.renderStarted <= event.startedAt);
});

test('sequence는 단조 증가한다', () => {
  const env = makeEnv([makeBundle(), makeBundle()]);
  activateWork(env);
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
  activateWork(env);
  run(env, sessionInput());
  const r = run(env, sessionInput());
  assert.doesNotMatch(r.stdout, /원|₩|KRW/);
  assert.match(r.stdout, /누적 예상.*P/);
});

test('1P 미만 미전송 적립도 소수점 진행으로 표시한다', () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'ledger-summary.json'), JSON.stringify({
    version: 1, totalImpressions: 1, unsyncedImpressions: 1,
    today: new Date().toISOString().slice(0, 10), todayImpressions: 1, nextSequence: 1, updatedAt: Date.now(),
  }));
  activateWork(env);
  // 0.3P를 한 번에 띄우지 않고 0.1P씩 올린다. 실제 적립분(0.3P)을 넘지 않고 거기서 멈춘다.
  const steps = [];
  for (let i = 0; i < 4; i += 1) {
    const r = run(env, sessionInput());
    assert.strictEqual(r.status, 0);
    steps.push(r.stdout.match(/누적 예상 ([\d.,]+)P/)[1].replace(',', '.'));
  }
  assert.deepStrictEqual(steps, ['0.1', '0.2', '0.3', '0.3']);
});

test('낮은 유효 정책 단가에서도 양수 적립 진행을 0P로 반올림하지 않는다', () => {
  const env = makeEnv();
  const policy = require('../policy/policy').loadPolicy();
  policy.reward = {
    ...policy.reward,
    rewardPerThousandAcceptedImpressions: 1,
    dailyAcceptedImpressionLimit: 1000,
    dailyRewardLimit: 1,
    minimumRedemptionPoints: 1,
    maxReasonableRedemptionDays: 1,
  };
  const policyFile = path.join(env.CLAWAD_DATA, 'reward-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  env.CLAWAD_POLICY_FILE = policyFile;
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'ledger-summary.json'), JSON.stringify({
    version: 1, totalImpressions: 1, unsyncedImpressions: 1,
    today: new Date().toISOString().slice(0, 10), todayImpressions: 1, nextSequence: 1, updatedAt: Date.now(),
  }));
  activateWork(env);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /누적 예상 0[.,]001P/);
  assert.doesNotMatch(r.stdout, /누적 예상 0P/);
});

test('광고 준비 상태를 동기화 중·네트워크 재시도로 구분한다', () => {
  const syncing = makeEnv([]);
  fs.writeFileSync(path.join(syncing.CLAWAD_DATA, 'auth.json'), '{}');
  fs.writeFileSync(path.join(syncing.CLAWAD_DATA, 'preparation-state.json'), JSON.stringify({ state: 'SYNCING' }));
  assert.match(run(syncing, sessionInput()).stdout, /동기화 중/);

  const retry = makeEnv([]);
  fs.writeFileSync(path.join(retry.CLAWAD_DATA, 'auth.json'), '{}');
  fs.writeFileSync(path.join(retry.CLAWAD_DATA, 'sync-state.json'), JSON.stringify({ lastError: { code: 'NETWORK_UNAVAILABLE' } }));
  assert.match(run(retry, sessionInput()).stdout, /네트워크 복구 후.*재시도/);
});

test('서버 포인트 캐시를 검증 중·확정으로 구분하고 오래되면 지연 표시한다', () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'reward-summary.json'), JSON.stringify({
    version: 1, verifyingPoints: 12, confirmedPoints: 34, fetchedAt: Date.now() - 20 * 60 * 1000,
  }));
  activateWork(env);
  const r = run(env, sessionInput());
  assert.match(r.stdout, /검증 중 12P/);
  assert.match(r.stdout, /확정 34P \(지연\)/);
  assert.doesNotMatch(r.stdout, /KRW|원/);
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
  activateWork(env, 'parallel-a');
  activateWork(env, 'parallel-b');
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
  activateWork(env, 'healthy');
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

test('대기 중에는 광고 대신 안내문을 한 줄로 표시한다', () => {
  const env = makeEnv();
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /\[광고\]/, '작업 중이 아닐 때 광고를 노출하지 않는다.');
  assert.match(r.stdout, /clawad: /);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1);
  assert.strictEqual(readEvents(env).length, 0, '표시하지 않은 광고를 인정 노출로 기록하면 안 된다.');
});

test('대기 중 안내문은 정책값을 인용하고 돌아가며 바뀐다', () => {
  const policy = require('../policy/policy').loadPolicy();
  const rotateSeconds = policy.statusLine.adRotateMs / 1000;
  const env = makeEnv();
  const seen = new Set();
  // 안내문은 adRotateMs 주기로 바뀐다. 시간을 직접 못 바꾸므로 여러 번 실행해 최소 한 종류는 확인하고,
  // 문구 집합 자체는 소스에서 정책값 인용 여부로 검증한다.
  for (let i = 0; i < 3; i += 1) seen.add(run(env, sessionInput()).stdout.trim());
  assert.ok(seen.size >= 1);

  const source = fs.readFileSync(STATUSLINE, 'utf8');
  assert.match(source, /\$\{seconds\(rotateMs\)\}초마다/, '로테이션 주기를 하드코딩하지 않는다.');
  assert.match(source, /\$\{seconds\(minViewMs\)\}초 이상/, '최소 시청 시간을 하드코딩하지 않는다.');
  assert.match(source, /\$\{pointsPerThousand\.toLocaleString/, '적립 단가를 하드코딩하지 않는다.');
  assert.doesNotMatch(source, /15초마다|5초 이상 보면 리워드|300P가 적립/, '정책 수치를 문구에 고정하면 안 된다.');
  assert.ok(rotateSeconds > 0);
});

test('작업이 끝난 직후 실행에서도 마지막 활성 구간의 인정 노출을 잃지 않는다', () => {
  const env = makeEnv();
  const now = Date.now();
  activateWork(env);
  run(env, sessionInput());
  // 광고가 최소 시청 시간을 넘겨 표시된 뒤 작업이 끝난 상태를 만든다.
  const shown = now - MIN_VIEW_MS - 3000;
  const state = JSON.parse(fs.readFileSync(stateOf(env), 'utf8'));
  fs.writeFileSync(stateOf(env), JSON.stringify({ ...state, shownAt: shown, updatedAt: shown, counted: false }));
  fs.writeFileSync(workStateOf(env), JSON.stringify({
    version: 1, active: false, intervals: [{ startedAt: shown - 1000, endedAt: now }], updatedAt: now,
  }));
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /clawad: /, '작업이 끝났으므로 화면은 안내문이다.');
  assert.strictEqual(readEvents(env).length, 1, '표시된 광고의 인정 노출은 그대로 기록돼야 한다.');
});

test('staleActiveMs를 넘긴 긴 턴에서도 작업 중이면 광고를 계속 표시한다', () => {
  const STALE_MS = require('../policy/policy').loadPolicy().activity.staleActiveMs;
  const env = makeEnv();
  const file = workStateOf(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 훅이 start만 보낸 상태로 staleActiveMs를 넘겨 작업이 이어지는 경우(긴 턴).
  fs.writeFileSync(file, JSON.stringify({
    version: 1, active: true, startedAt: Date.now() - STALE_MS - 60000, intervals: [], updatedAt: Date.now(),
  }));
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\[광고\]/, '2분 넘게 걸리는 턴에서 광고가 사라지면 안 된다.');
});

test('인정 노출 후에도 로테이션 주기를 채울 때까지 같은 광고를 유지한다 (CLAW-101)', () => {
  const env = makeEnv([makeBundle(), makeBundle({ ad: { campaignId: 'c2', creativeId: 'cr-2', text: '두번째 광고', brand: '브랜드2', label: '광고', campaignType: 'PAID' } })]);
  activateWork(env);
  const first = run(env, sessionInput());
  const shownFirst = first.stdout.includes('테스트 광고');
  backdate(env, MIN_VIEW_MS + 100);
  run(env, sessionInput());
  assert.strictEqual(readEvents(env).length, 1, '5초를 넘겼으므로 1건 인정된다.');
  // 집계 즉시 번들은 캐시에서 빠지지만, 화면은 로테이션 주기가 끝날 때까지 같은 광고를 유지한다.
  const held = run(env, sessionInput());
  assert.match(held.stdout, /\[광고\]/);
  assert.strictEqual(held.stdout.includes('테스트 광고'), shownFirst, '주기 도중에 광고가 바뀌면 안 된다.');
  assert.strictEqual(readEvents(env).length, 1, '붙잡고 있는 동안 중복 집계하면 안 된다.');
});

test('로테이션 주기가 끝나면 직전과 다른 소재를 표시한다 (CLAW-101)', () => {
  const env = makeEnv([
    makeBundle(),
    makeBundle({ ad: { campaignId: 'c2', creativeId: 'cr-2', text: '두번째 광고', brand: '브랜드2', label: '광고', campaignType: 'PAID' } }),
  ]);
  activateWork(env);
  const before = run(env, sessionInput());
  backdate(env, ROTATE_MS + 100);
  const after = run(env, sessionInput());
  const textOf = (out) => (out.includes('두번째 광고') ? 'cr-2' : 'cr-1');
  assert.notStrictEqual(textOf(after.stdout), textOf(before.stdout), '주기 후에는 다른 소재여야 한다.');
});

test('오프라인 누적처럼 격차가 크면 예상 적립을 연출 없이 즉시 맞춘다 (CLAW-101)', () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'ledger-summary.json'), JSON.stringify({
    version: 1, totalImpressions: 100, unsyncedImpressions: 100,
    today: new Date().toISOString().slice(0, 10), todayImpressions: 100, nextSequence: 100, updatedAt: Date.now(),
  }));
  activateWork(env);
  const r = run(env, sessionInput());
  assert.match(r.stdout, /누적 예상 30P/, '0.1씩 올리면 300번 걸린다 — 큰 격차는 즉시 맞춘다.');
});

test('sync로 미전송분이 0이 되어도 누적 예상이 0으로 리셋되지 않는다 (CLAW-104)', () => {
  const env = makeEnv();
  const today = new Date().toISOString().slice(0, 10);
  const writeSummary = (unsynced) => fs.writeFileSync(
    path.join(env.CLAWAD_DATA, 'ledger-summary.json'),
    JSON.stringify({ version: 1, totalImpressions: 3, unsyncedImpressions: unsynced, today, todayImpressions: 3, nextSequence: 3, updatedAt: Date.now() }),
  );
  activateWork(env);
  writeSummary(3); // 미전송 3건 = 0.9P, 1P 미만
  let last;
  for (let i = 0; i < 12; i += 1) last = run(env, sessionInput()); // 0.1P씩 래치가 0.9까지 오름
  const before = Number(last.stdout.match(/누적 예상 ([\d.,]+)P/)[1].replace(',', '.'));
  assert.ok(before > 0, '미전송분이 누적 예상으로 표시돼야 한다.');
  // sync 시뮬레이션: 미전송분이 서버로 옮겨갔지만 1P 미만이라 확정·검증은 아직 0(캐리 은닉).
  writeSummary(0);
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'reward-summary.json'), JSON.stringify({
    version: 1, verifyingPoints: 0, confirmedPoints: 0, fetchedAt: Date.now(),
  }));
  const after = run(env, sessionInput());
  const shown = Number(after.stdout.match(/누적 예상 ([\d.,]+)P/)[1].replace(',', '.'));
  assert.ok(shown >= before, `누적 예상은 sync 후에도 유지돼야 한다 (before=${before}, after=${shown}).`);
});

test('대기 중 안내문에도 적립 현황을 함께 표시한다 (CLAW-105)', () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'reward-summary.json'), JSON.stringify({
    version: 1, verifyingPoints: 0, confirmedPoints: 7, fetchedAt: Date.now(),
  }));
  // 작업을 활성화하지 않는다 → 대기 중 안내문 경로.
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /\[광고\]/, '안내문은 광고가 아니므로 [광고]를 붙이지 않는다.');
  assert.match(r.stdout, /확정 7P/, '대기 중에도 확정 포인트를 보여준다.');
  assert.strictEqual(r.stdout.trim().split('\n').length, 1, '출력은 정확히 한 줄이어야 한다.');
});

test('단가를 못 읽으면 대기 안내문에 0P 적립 문구를 넣지 않는다 (CLAW-105)', () => {
  const env = makeEnv();
  const policy = require('../policy/policy').loadPolicy();
  policy.reward = { ...policy.reward, rewardPerThousandAcceptedImpressions: 0 };
  const policyFile = path.join(env.CLAWAD_DATA, 'reward-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  env.CLAWAD_POLICY_FILE = policyFile;
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /0P/, '단가 미확보 시 0P 적립 문구를 만들지 않는다.');
});

test('일일 인정 노출 상한을 채우면 광고 대신 안내문을 표시한다 (CLAW-101)', () => {
  const limit = require('../policy/policy').loadPolicy().reward.dailyAcceptedImpressionLimit;
  const env = makeEnv();
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'ledger-summary.json'), JSON.stringify({
    version: 1, totalImpressions: limit, unsyncedImpressions: 0,
    today: new Date().toISOString().slice(0, 10), todayImpressions: limit, nextSequence: limit, updatedAt: Date.now(),
  }));
  activateWork(env);
  const r = run(env, sessionInput());
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /\[광고\]/, '상한을 채운 뒤에는 광고를 노출하지 않는다.');
  assert.match(r.stdout, /오늘 적립 상한을 채웠어요/);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1);
  assert.strictEqual(readEvents(env).length, 0);
});
