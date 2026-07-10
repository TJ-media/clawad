'use strict';
// server/index.js 스모크 — 광고 서빙, 노출 수집 멱등성, 집계
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const PORT = 18787;
const BASE = `http://localhost:${PORT}`;

let proc;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-server-test-'));
  const ads = path.join(dir, 'ads.json');
  fs.writeFileSync(ads, JSON.stringify([{ id: 'test-ad', brand: '테스트', text: '테스트 광고' }]));

  proc = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT), CLAWAD_ADS: ads, CLAWAD_IMP_FILE: path.join(dir, 'imp.jsonl') },
    stdio: 'ignore',
  });

  // 서버가 뜰 때까지 대기 (최대 5초)
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/ads`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('서버 기동 실패');
});

after(() => {
  if (proc) proc.kill();
});

test('GET /ads가 인벤토리를 반환한다', async () => {
  const res = await fetch(`${BASE}/ads`);
  assert.strictEqual(res.status, 200);
  const ads = await res.json();
  assert.strictEqual(ads[0].id, 'test-ad');
});

test('POST /impressions는 key 기준 멱등이다', async () => {
  const entry = { key: 'test-ad:123', adId: 'test-ad', gross: 1, user: 0.5 };

  const first = await fetch(`${BASE}/impressions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([entry]),
  });
  assert.deepStrictEqual(await first.json(), { received: 1, accepted: 1 });

  const second = await fetch(`${BASE}/impressions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([entry]),
  });
  assert.deepStrictEqual(await second.json(), { received: 1, accepted: 0 });
});

test('잘못된 본문에 400을 반환한다', async () => {
  const res = await fetch(`${BASE}/impressions`, { method: 'POST', body: 'broken' });
  assert.strictEqual(res.status, 400);
});

test('GET /stats가 광고별로 집계한다', async () => {
  const res = await fetch(`${BASE}/stats`);
  const stats = await res.json();
  assert.strictEqual(stats['test-ad'].impressions, 1);
  assert.strictEqual(stats['test-ad'].userShare, 0.5);
});
