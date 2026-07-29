'use strict';
// 활동 감지 훅과 노출 인정의 연결 (CLAW-51, CLAW-134).
// 광고 표시는 오버레이가 하고 인정은 스풀 수거가 한다 — 활성 구간의 출처는 여전히 이 훅이다.
// 훅이 만든 work-state와 오버레이가 남긴 표시 사실이 겹칠 때만 인정 노출이 된다.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

// 수거는 dataDir 인자로만 동작해야 한다. 개발 환경의 CLAWAD_* 설정이 테스트에 새지 않게 지운다.
for (const name of ['CLAWAD_DATA', 'CLAWAD_BUNDLES', 'CLAWAD_LEDGER', 'CLAWAD_MACHINE', 'CLAWAD_OVERLAY_SPOOL']) {
  delete process.env[name];
}

const HOOK = path.join(__dirname, '..', 'client', 'work-activity.js');
const { collectOverlayEvents } = require('../client/overlay-events');
const policy = require('../policy/policy').loadPolicy();
const MIN_VIEW_MS = policy.impression.minViewMs;
const STALE_ACTIVE_MS = policy.activity.staleActiveMs;
const SESSION = 'active-session';

function scene() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-active-'));
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([{
    serveToken: 'token.active', expiresAt: Date.now() + 60000, minViewMs: MIN_VIEW_MS,
    ad: { text: '활성 작업 광고', brand: '클로애드', campaignType: 'PAID' },
  }]));
  return { data, env: { ...process.env, CLAWAD_DATA: data } };
}

function hook(action, environment, payload = { session_id: SESSION }) {
  return spawnSync(process.execPath, [HOOK, action], { env: environment, input: JSON.stringify(payload), encoding: 'utf8' });
}

function workFile(data, session = SESSION) {
  const key = crypto.createHash('sha256').update(session).digest('hex').slice(0, 32);
  return path.join(data, 'work-state', `${key}.json`);
}

function patchWorkState(data, mutate) {
  const file = workFile(data);
  const work = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(work);
  fs.writeFileSync(file, JSON.stringify(work));
  return work;
}

/** 오버레이가 광고 한 건을 표시했다는 사실. 채번·머신 ID·판정은 수거가 한다. */
function spoolDisplay(data, { startedAt, endedAt }) {
  const dir = path.join(data, 'overlay-events');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${crypto.randomBytes(16).toString('hex')}.json`), JSON.stringify({
    version: 1, serveToken: 'token.active', renderStarted: startedAt,
    displayStartedAt: startedAt, displayEndedAt: endedAt,
  }));
}

function ledger(data) {
  const file = path.join(data, 'ledger.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

test('첫 프롬프트 전 PAID 광고는 원장에 기록하지 않는다', () => {
  const { data } = scene();
  const now = Date.now();
  // 훅이 한 번도 실행되지 않아 활성 구간이 없다 = 겹칠 구간이 없다.
  spoolDisplay(data, { startedAt: now - MIN_VIEW_MS - 1000, endedAt: now - 500 });

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 0);
  assert.strictEqual(result.dropped.BELOW_MIN_VIEW, 1);
  assert.strictEqual(ledger(data).length, 0);
});

test('활성 작업 5초 이상만 유효 노출로 기록하고 프롬프트 본문을 저장하지 않는다', () => {
  const { data, env } = scene();
  hook('start', env, { session_id: SESSION, prompt: '비밀 프롬프트', cwd: '/secret' });
  const work = patchWorkState(data, (value) => { value.startedAt -= MIN_VIEW_MS + 1000; });
  const now = Date.now();
  spoolDisplay(data, { startedAt: work.startedAt, endedAt: now - 100 });

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 1);
  const [event] = ledger(data);
  assert.ok(event.endedAt - event.startedAt >= MIN_VIEW_MS);
  const stored = fs.readFileSync(workFile(data), 'utf8');
  assert.ok(!stored.includes('비밀 프롬프트'));
  assert.ok(!stored.includes('/secret'));
});

test('Stop 이후 시간은 유효 표시시간에 더해지지 않는다', () => {
  const { data, env } = scene();
  hook('start', env);
  hook('stop', env);
  // 실제 활성 구간은 1초 남짓이다. 표시 구간이 아무리 길어도 교집합은 그만큼뿐이다.
  const work = patchWorkState(data, (value) => {
    value.intervals[0].startedAt -= 1000;
    value.intervals[0].endedAt -= 1000;
  });
  const now = Date.now();
  spoolDisplay(data, { startedAt: work.intervals[0].startedAt, endedAt: now });

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 0);
  assert.strictEqual(result.dropped.BELOW_MIN_VIEW, 1);
  assert.strictEqual(ledger(data).length, 0);
});

test('오래된 활성 상태는 stale 처리되어 유효 노출로 기록하지 않는다', () => {
  const { data } = scene();
  const now = Date.now();
  // 훅이 stop을 못 보낸 채 끊긴 세션. staleActiveMs를 넘긴 뒤의 표시는 인정하지 않는다.
  const startedAt = now - STALE_ACTIVE_MS - 60000;
  fs.mkdirSync(path.dirname(workFile(data)), { recursive: true });
  fs.writeFileSync(workFile(data), JSON.stringify({ version: 1, active: true, startedAt, intervals: [], updatedAt: startedAt }));
  spoolDisplay(data, { startedAt: now - MIN_VIEW_MS - 1000, endedAt: now - 100 });

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 0);
  assert.strictEqual(ledger(data).length, 0);
});
