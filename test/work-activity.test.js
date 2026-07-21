'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const HOOK = path.join(__dirname, '..', 'client', 'work-activity.js');
const STATUSLINE = path.join(__dirname, '..', 'client', 'statusline.js');
const MIN_VIEW_MS = require('../policy/policy').loadPolicy().impression.minViewMs;

function bundle() {
  return { serveToken: 'token.active', expiresAt: Date.now() + 60000, minViewMs: MIN_VIEW_MS,
    ad: { text: '활성 작업 광고', brand: '클로애드', campaignType: 'PAID' } };
}
function env() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-active-'));
  fs.writeFileSync(path.join(data, 'bundles.json'), JSON.stringify([bundle()]));
  return { ...process.env, CLAWAD_DATA: data, CLAWAD_BUNDLES: path.join(data, 'bundles.json') };
}
function run(file, args, environment, input) {
  return spawnSync(process.execPath, [file, ...args], { env: environment, input, encoding: 'utf8' });
}
function input(session = 'active-session') { return JSON.stringify({ session_id: session }); }
function ledger(data) {
  const file = path.join(data, 'ledger.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function stateFile(data, session = 'active-session') {
  const key = crypto.createHash('sha256').update(session).digest('hex').slice(0, 32);
  return path.join(data, 'session-state', `${key}.json`);
}
function workFile(data, session = 'active-session') {
  const key = crypto.createHash('sha256').update(session).digest('hex').slice(0, 32);
  return path.join(data, 'work-state', `${key}.json`);
}

test('첫 프롬프트 전 PAID 광고는 원장에 기록하지 않는다', () => {
  const environment = env();
  run(STATUSLINE, [], environment, input());
  const state = JSON.parse(fs.readFileSync(stateFile(environment.CLAWAD_DATA), 'utf8'));
  state.shownAt -= MIN_VIEW_MS + 100;
  fs.writeFileSync(stateFile(environment.CLAWAD_DATA), JSON.stringify(state));
  run(STATUSLINE, [], environment, input());
  assert.strictEqual(ledger(environment.CLAWAD_DATA).length, 0);
});

test('활성 작업 5초 이상만 유효 노출로 기록하고 프롬프트 본문을 저장하지 않는다', () => {
  const environment = env();
  run(STATUSLINE, [], environment, input());
  run(HOOK, ['start'], environment, JSON.stringify({ session_id: 'active-session', prompt: '비밀 프롬프트', cwd: '/secret' }));
  const state = JSON.parse(fs.readFileSync(stateFile(environment.CLAWAD_DATA), 'utf8'));
  state.shownAt -= MIN_VIEW_MS + 100;
  fs.writeFileSync(stateFile(environment.CLAWAD_DATA), JSON.stringify(state));
  const work = JSON.parse(fs.readFileSync(workFile(environment.CLAWAD_DATA), 'utf8'));
  work.startedAt -= MIN_VIEW_MS + 100;
  fs.writeFileSync(workFile(environment.CLAWAD_DATA), JSON.stringify(work));
  run(STATUSLINE, [], environment, input());
  const [event] = ledger(environment.CLAWAD_DATA);
  assert.ok(event.endedAt - event.startedAt >= MIN_VIEW_MS);
  assert.ok(!fs.readFileSync(workFile(environment.CLAWAD_DATA), 'utf8').includes('비밀 프롬프트'));
  assert.ok(!fs.readFileSync(workFile(environment.CLAWAD_DATA), 'utf8').includes('/secret'));
});

test('Stop 이후 시간은 유효 표시시간에 더해지지 않는다', () => {
  const environment = env();
  run(STATUSLINE, [], environment, input());
  run(HOOK, ['start'], environment, input());
  run(HOOK, ['stop'], environment, input());
  const work = JSON.parse(fs.readFileSync(workFile(environment.CLAWAD_DATA), 'utf8'));
  work.intervals[0].startedAt -= 1000;
  work.intervals[0].endedAt -= 1000;
  fs.writeFileSync(workFile(environment.CLAWAD_DATA), JSON.stringify(work));
  const state = JSON.parse(fs.readFileSync(stateFile(environment.CLAWAD_DATA), 'utf8'));
  state.shownAt -= MIN_VIEW_MS + 100;
  fs.writeFileSync(stateFile(environment.CLAWAD_DATA), JSON.stringify(state));
  run(STATUSLINE, [], environment, input());
  assert.strictEqual(ledger(environment.CLAWAD_DATA).length, 0);
});

test('오래된 활성 상태는 stale 처리되어 유효 노출로 기록하지 않는다', () => {
  const environment = env();
  run(STATUSLINE, [], environment, input());
  const file = workFile(environment.CLAWAD_DATA);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, active: true, startedAt: Date.now() - 130000, intervals: [], updatedAt: Date.now() - 130000 }));
  run(STATUSLINE, [], environment, input());
  assert.strictEqual(ledger(environment.CLAWAD_DATA).length, 0);
});
