'use strict';
// server/index.js 통합 스모크 — 새 모델(serveToken·기기 제한·동시 노출·캠페인 유형).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const PORT = 18788;
const BASE = `http://localhost:${PORT}`;

let proc;
let dir;

async function decision(machineId, userId = 'u-1') {
  const r = await fetch(
    `${BASE}/v1/ad-decision?machineId=${encodeURIComponent(machineId)}&userId=${encodeURIComponent(userId)}`
  );
  return (await r.json()).serveToken;
}

function ev(token, over) {
  const base = {
    serveToken: token,
    sequence: 1,
    machineId: 'm-1',
    startedAt: 1_000_000,
    endedAt: 1_006_000, // 6초 → viewability 통과
    userId: 'u-1',
    clientVersion: '0.1.0',
  };
  return { ...base, ...over };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-server-test-'));
  const ads = path.join(dir, 'ads.json');
  fs.writeFileSync(ads, JSON.stringify([{ id: 'camp-1', brand: '테스트', text: '테스트 광고', campaignType: 'PAID' }]));
  proc = spawn('node', [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLAWAD_ADS: ads,
      CLAWAD_EVENTS_FILE: path.join(dir, 'events.jsonl'),
      CLAWAD_DEVICES_FILE: path.join(dir, 'devices.jsonl'),
      CLAWAD_TOKEN_SECRET: 'test-secret',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/v1/ads`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('서버 기동 실패');
});

after(() => proc && proc.kill());

test('ad-decision은 serveToken을 발급한다', async () => {
  const r = await fetch(`${BASE}/v1/ad-decision?machineId=m-1&userId=u-1`);
  assert.strictEqual(r.status, 200);
  const b = await r.json();
  assert.ok(b.serveToken);
  assert.strictEqual(b.ad.label, '광고');
  assert.strictEqual(b.minViewMs, 5000);
});

test('기기 3대까지 등록되고 4대째는 409 MACHINE_LIMIT_EXCEEDED', async () => {
  const reg = (machineId) =>
    fetch(`${BASE}/v1/machines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'dev-user', machineId }),
    });
  assert.strictEqual((await reg('d1')).status, 201);
  assert.strictEqual((await reg('d2')).status, 201);
  assert.strictEqual((await reg('d3')).status, 201);
  const fourth = await reg('d4');
  assert.strictEqual(fourth.status, 409);
  assert.strictEqual((await fourth.json()).error, 'MACHINE_LIMIT_EXCEEDED');

  // 기존 기기 해제 후 새 기기 등록 성공
  await fetch(`${BASE}/v1/machines/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'dev-user', machineId: 'd1' }),
  });
  assert.strictEqual((await reg('d4')).status, 201);
});

test('유효 노출 1건 수집 + 재전송 멱등(중복 적립 없음)', async () => {
  const token = await decision('m-1');
  const post = (body) =>
    fetch(`${BASE}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const first = await (await post([ev(token, { sequence: 10 })])).json();
  assert.strictEqual(first.accepted, 1);
  // 같은 토큰·머신·순번 재전송 → 멱등, 추가 적립 없음
  const again = await (await post([ev(token, { sequence: 10 })])).json();
  assert.strictEqual(again.accepted, 1); // 멱등 반환(이전 결과 ACCEPTED)
});

test('다른 사용자는 발급 사용자의 serveToken을 제출할 수 없다', async () => {
  const token = await decision('m-user', 'u-owner');
  const r = await fetch(`${BASE}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ev(token, { sequence: 30, machineId: 'm-user', userId: 'u-attacker' }),
    ]),
  });
  const result = await r.json();
  assert.strictEqual(result.accepted, 0);
  assert.strictEqual(result.rejected.TOKEN_USER_MISMATCH, 1);
});

test('클라이언트가 금액 필드를 실어도 무시된다', async () => {
  const token = await decision('m-9', 'u-amt');
  const r = await fetch(`${BASE}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ev(token, { sequence: 77, machineId: 'm-9', userId: 'u-amt', gross: 999999, userShare: 999999, rewardAmount: 999999 }),
    ]),
  });
  assert.strictEqual((await r.json()).accepted, 1);
  const stats = await (await fetch(`${BASE}/v1/stats`)).json();
  // 리워드는 서버가 정책으로 계산 — 클라이언트가 보낸 999999가 반영되지 않는다.
  assert.ok(stats.rewardPoints < 1000);
});

test('같은 사용자 다른 기기의 동시 노출은 한 건만 인정(CONCURRENT_USER_IMPRESSION)', async () => {
  const t1 = await decision('mA', 'u-conc');
  const t2 = await decision('mB', 'u-conc');
  const post = (body) =>
    fetch(`${BASE}/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // 첫 기기 노출 승인
  const r1 = await (await post([ev(t1, { sequence: 1, machineId: 'mA', userId: 'u-conc', startedAt: 5_000_000, endedAt: 5_006_000 })])).json();
  assert.strictEqual(r1.accepted, 1);
  // 두 번째 기기, 시간 겹침 → 거절
  const r2 = await (await post([ev(t2, { sequence: 1, machineId: 'mB', userId: 'u-conc', startedAt: 5_002_000, endedAt: 5_008_000 })])).json();
  assert.strictEqual(r2.accepted, 0);
  assert.strictEqual(r2.rejected.CONCURRENT_USER_IMPRESSION, 1);
});

test('만료·변조 토큰은 거절되고, 잘못된 본문은 400', async () => {
  const post = (body) =>
    fetch(`${BASE}/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const bad = await (await post([ev('garbage-token', { sequence: 5, machineId: 'mz', userId: 'uz' })])).json();
  assert.strictEqual(bad.accepted, 0);
  assert.ok(bad.rejected.BAD_TOKEN >= 1);
  const broken = await fetch(`${BASE}/v1/events`, { method: 'POST', body: 'not-json' });
  assert.strictEqual(broken.status, 400);
});
