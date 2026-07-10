'use strict';
// statusline.js 스모크 — viewability(5초), 중복 방지, 깨진 입력 견고성
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUSLINE = path.join(__dirname, '..', 'client', 'statusline.js');

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-test-'));
  const ads = path.join(dir, 'ads.json');
  fs.writeFileSync(
    ads,
    JSON.stringify([{ id: 'test-ad', brand: '테스트', text: '테스트 광고', url: 'https://example.com' }])
  );
  return { ...process.env, CLAWAD_DATA: dir, CLAWAD_ADS: ads };
}

function run(env, input) {
  return spawnSync('node', [STATUSLINE], { input, env, encoding: 'utf8' });
}

test('광고 한 줄을 출력하고 exit 0', () => {
  const env = makeEnv();
  const r = run(env, '{}');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\[광고\]/);
  assert.match(r.stdout, /테스트 광고/);
});

test('깨진 stdin에도 광고를 출력하고 exit 0', () => {
  const env = makeEnv();
  const r = run(env, 'not-json{{{');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\[광고\]/);
});

test('5초 미만 노출은 집계하지 않는다', () => {
  const env = makeEnv();
  run(env, '{}');
  assert.ok(!fs.existsSync(path.join(env.CLAWAD_DATA, 'ledger.jsonl')));
});

test('5초 이상 노출은 정확히 1회만 집계한다', () => {
  const env = makeEnv();
  run(env, '{}');
  const stateFile = path.join(env.CLAWAD_DATA, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.shownAt -= 6000; // 6초 전에 노출 시작한 것으로 백데이트
  fs.writeFileSync(stateFile, JSON.stringify(state));

  run(env, '{}');
  run(env, '{}'); // 같은 슬롯 재호출 — 중복 집계되면 안 됨

  const ledger = fs
    .readFileSync(path.join(env.CLAWAD_DATA, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  assert.strictEqual(ledger.length, 1);

  const entry = JSON.parse(ledger[0]);
  assert.strictEqual(entry.adId, 'test-ad');
  assert.strictEqual(entry.user, 0.5);
  assert.ok(entry.key.startsWith('test-ad:'));
});
