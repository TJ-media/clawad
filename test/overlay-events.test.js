'use strict';
// 오버레이 노출 이벤트 스풀 수거 테스트 (CLAW-90)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 수거는 dataDir 인자로만 동작해야 한다. 개발 환경의 CLAWAD_* 설정이 테스트에 새지 않게 지운다.
for (const name of ['CLAWAD_DATA', 'CLAWAD_BUNDLES', 'CLAWAD_LEDGER', 'CLAWAD_MACHINE', 'CLAWAD_OVERLAY_SPOOL']) {
  delete process.env[name];
}

const { collectOverlayEvents, writeTriggerPointer } = require('../client/overlay-events');
const policy = require('../policy/policy').loadPolicy();
const MIN_VIEW_MS = policy.impression.minViewMs;
const EVENT_FIELDS = ['serveToken', 'sequence', 'machineId', 'renderStarted', 'startedAt', 'endedAt', 'clientVersion', 'synced'];

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-overlay-'));
}

function writeBundles(data, tokens) {
  const bundles = tokens.map((serveToken) => ({
    serveToken,
    expiresAt: Date.now() + 600000,
    minViewMs: MIN_VIEW_MS,
    ad: { text: '오버레이 광고', brand: '클로애드', campaignType: 'PAID', creativeId: 'creative-1' },
  }));
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify(bundles));
}

/** 활성 작업 구간을 하나 가진 work-state 파일을 만든다. statusline이 쓰는 것과 같은 포맷이다. */
function writeWorkState(data, interval, session = 'overlay-session') {
  const dir = path.join(data, 'work-state');
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('sha256').update(session).digest('hex').slice(0, 32);
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
    version: 1, active: false, intervals: [interval], updatedAt: interval.endedAt,
  }));
}

function spool(data, event, { bom = false, raw = null } = {}) {
  const dir = path.join(data, 'overlay-events');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.json`);
  const body = raw !== null ? raw : JSON.stringify(event);
  fs.writeFileSync(file, bom ? `﻿${body}` : body);
  return file;
}

/** 표시 구간과 활성 구간이 정확히 겹치는 정상 스풀 이벤트. */
function displayed(now, { serveToken = 'token.overlay', viewMs = MIN_VIEW_MS + 1000 } = {}) {
  const displayEndedAt = now - 1000;
  const displayStartedAt = displayEndedAt - viewMs;
  return { version: 1, serveToken, renderStarted: displayStartedAt, displayStartedAt, displayEndedAt };
}

function ledger(data) {
  const file = path.join(data, 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function spoolFiles(data) {
  const dir = path.join(data, 'overlay-events');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function scene({ viewMs = MIN_VIEW_MS + 1000, tokens = ['token.overlay'] } = {}) {
  const now = Date.now();
  const data = dataDir();
  writeBundles(data, tokens);
  const event = displayed(now, { serveToken: tokens[0], viewMs });
  writeWorkState(data, { startedAt: event.displayStartedAt - 500, endedAt: event.displayEndedAt + 500 });
  return { now, data, event };
}

test('활성 구간과 최소 시청 시간 이상 겹친 표시 사실은 원장에 인정 노출로 기록된다', () => {
  const { now, data, event } = scene();
  spool(data, event);

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 1);
  const events = ledger(data);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].serveToken, 'token.overlay');
  assert.strictEqual(events[0].sequence, 1);
  assert.strictEqual(events[0].synced, false);
  assert.strictEqual(events[0].renderStarted, event.renderStarted);
  // 유효 노출 구간 = 활성 ∩ 표시. 표시 구간을 넘어서지 않는다.
  assert.strictEqual(events[0].startedAt, event.displayStartedAt);
  assert.strictEqual(events[0].endedAt, event.displayEndedAt);
  // 수거된 스풀 파일은 삭제되고, 단일 사용 토큰은 후보에서 사라진다.
  assert.deepStrictEqual(spoolFiles(data), []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(data, 'bundles.json'), 'utf8')), []);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'sequence.json'), 'utf8')).nextSequence, 1);
});

test('원장 이벤트는 8개 필드만 갖는다 — 스풀의 금액·식별자 필드는 싣지 않는다', () => {
  const { now, data, event } = scene();
  // 오버레이가 규칙을 어기고 금액·캠페인 식별자·머신 ID를 밀어 넣어도 원장으로 새지 않아야 한다.
  spool(data, {
    ...event,
    grossKrw: 1000, userPoints: 300, campaignId: 'c0ffee', tokenJti: 'jti-1',
    machineId: 'ffffffffffffffffffffffffffffffff', sequence: 999, clientVersion: '9.9.9', userId: 'user-1',
  });

  assert.strictEqual(collectOverlayEvents({ dataDir: data, now }).collected, 1);
  const [record] = ledger(data);
  assert.deepStrictEqual(Object.keys(record), EVENT_FIELDS);
  // 채번·머신 ID·버전은 서버측 클라이언트(clawad)가 정한다. 오버레이가 보낸 값을 쓰지 않는다.
  assert.strictEqual(record.sequence, 1);
  assert.notStrictEqual(record.machineId, 'ffffffffffffffffffffffffffffffff');
  assert.strictEqual(record.clientVersion, require('../package.json').version);
});

test('같은 serveToken이 원장에 있으면 중복 수거를 인정하지 않는다', () => {
  const { now, data, event } = scene();
  spool(data, event);
  assert.strictEqual(collectOverlayEvents({ dataDir: data, now }).collected, 1);

  // 트리거와 주기 sync가 겹쳐 같은 사실이 다시 스풀된 상황.
  spool(data, event);
  const again = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(again.collected, 0);
  assert.strictEqual(again.dropped.DUPLICATE, 1);
  assert.strictEqual(ledger(data).length, 1);
  assert.deepStrictEqual(spoolFiles(data), []);
});

test('최소 시청 시간에 못 미치는 교집합은 인정하지 않는다', () => {
  const { now, data, event } = scene({ viewMs: MIN_VIEW_MS - 1000 });
  spool(data, event);

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 0);
  assert.strictEqual(result.dropped.BELOW_MIN_VIEW, 1);
  assert.strictEqual(ledger(data).length, 0);
});

test('활성 작업 구간이 없으면 표시만으로는 인정하지 않는다', () => {
  const now = Date.now();
  const data = dataDir();
  writeBundles(data, ['token.overlay']);
  spool(data, displayed(now));

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 0);
  assert.strictEqual(result.dropped.BELOW_MIN_VIEW, 1);
  assert.strictEqual(ledger(data).length, 0);
});

test('캐시에 없는 토큰은 인정하지 않는다', () => {
  const { now, data, event } = scene();
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([]));
  spool(data, event);

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 0);
  assert.strictEqual(result.dropped.UNKNOWN_TOKEN, 1);
});

test('BOM이 붙은 스풀은 수거하고, 손상된 스풀은 폐기하며 크래시하지 않는다', () => {
  const { now, data, event } = scene();
  spool(data, event, { bom: true });
  spool(data, null, { raw: '{망가진 JSON' });
  spool(data, { version: 99, serveToken: 'token.overlay' });

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 1);
  assert.strictEqual(result.dropped.MALFORMED, 2);
  assert.deepStrictEqual(spoolFiles(data), []);
});

test('표시 구간이 뒤집힌 스풀은 인정하지 않는다', () => {
  const { now, data, event } = scene();
  spool(data, { ...event, displayEndedAt: event.displayStartedAt - 1 });
  // renderStarted가 표시 시작보다 늦은 것도 계약 위반이다.
  spool(data, { ...event, serveToken: 'token.overlay', renderStarted: event.displayStartedAt + 1 });

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 0);
  assert.strictEqual(result.dropped.MALFORMED, 2);
});

test('여러 건을 수거하면 sequence가 단조 증가한다', () => {
  const { now, data, event } = scene({ tokens: ['token.a', 'token.b'] });
  const second = { ...event, serveToken: 'token.b' };
  spool(data, event);
  spool(data, second);

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.collected, 2);
  assert.deepStrictEqual(ledger(data).map((e) => e.sequence).sort((a, b) => a - b), [1, 2]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'sequence.json'), 'utf8')).nextSequence, 2);
});

test('원장 복구가 대기 중이면 수거를 건너뛰고 스풀을 보존한다', () => {
  const { now, data, event } = scene();
  spool(data, event);
  fs.writeFileSync(path.join(data, 'ledger-summary-pending.json'), JSON.stringify({ createdAt: now }));

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.skipped, 'LEDGER_RECOVERY_PENDING');
  assert.strictEqual(ledger(data).length, 0);
  assert.strictEqual(spoolFiles(data).length, 1);
});

test('원장 잠금을 살아 있는 소유자가 쥐고 있으면 건너뛰고 스풀을 보존한다', () => {
  const { now, data, event } = scene();
  spool(data, event);
  const lockFile = path.join(data, 'ledger.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }));

  const result = collectOverlayEvents({ dataDir: data, now });

  assert.strictEqual(result.skipped, 'LEDGER_BUSY');
  assert.strictEqual(ledger(data).length, 0);
  assert.strictEqual(spoolFiles(data).length, 1);
  fs.unlinkSync(lockFile);
});

test('스풀 상한·보존기간을 넘긴 파일은 정책값에 따라 폐기한다', () => {
  const { now, data, event } = scene();
  const custom = { ...policy, overlay: { ...policy.overlay, eventSpoolMaxFiles: 2, eventSpoolRetentionMs: 60000 } };
  const policyFile = path.join(data, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(custom));
  process.env.CLAWAD_POLICY_FILE = policyFile;
  try {
    // 상한 초과분(오래된 것부터)과 보존기간 초과분을 함께 정리한다.
    // 같은 밀리초에 쓰이면 순서가 흔들리므로 mtime을 명시해 오래된 순서를 고정한다.
    const age = (file, ms) => fs.utimesSync(file, new Date(now - ms), new Date(now - ms));
    age(spool(data, { ...event, serveToken: 'token.stale' }), 120000);
    age(spool(data, { ...event, serveToken: 'token.1' }), 30000);
    age(spool(data, { ...event, serveToken: 'token.2' }), 20000);
    age(spool(data, event), 10000);

    const result = collectOverlayEvents({ dataDir: data, now });

    assert.strictEqual(result.purged, 2, '보존기간 초과 1건 + 상한 초과 1건');
    assert.strictEqual(result.collected, 1, '캐시에 있는 토큰만 인정된다');
    assert.strictEqual(spoolFiles(data).length, 0);
  } finally {
    delete process.env.CLAWAD_POLICY_FILE;
  }
});

test('우리 스풀 파일이 아닌 이름은 읽지도 지우지도 않는다', () => {
  const { now, data, event } = scene();
  const dir = path.join(data, 'overlay-events');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), '사용자 파일');
  spool(data, event);

  assert.strictEqual(collectOverlayEvents({ dataDir: data, now }).collected, 1);
  assert.deepStrictEqual(spoolFiles(data), ['notes.txt']);
});

test('스풀이 없으면 아무 것도 하지 않는다', () => {
  const data = dataDir();
  const result = collectOverlayEvents({ dataDir: data, now: Date.now() });
  assert.deepStrictEqual(result, { collected: 0, purged: 0, dropped: {} });
  assert.strictEqual(fs.existsSync(path.join(data, 'ledger.jsonl')), false);
});

test('수거 트리거 포인터는 현재 설치본을 가리키고 중복 기록하지 않는다', () => {
  const data = dataDir();
  assert.strictEqual(writeTriggerPointer({ dataDir: data }), true);
  const pointer = JSON.parse(fs.readFileSync(path.join(data, 'overlay-trigger.json'), 'utf8'));
  assert.strictEqual(pointer.node, process.execPath);
  assert.strictEqual(path.basename(pointer.script), 'overlay-events.js');
  assert.deepStrictEqual(pointer.args, ['collect']);
  assert.strictEqual(writeTriggerPointer({ dataDir: data }), false);
});
