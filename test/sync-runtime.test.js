'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireLock,
  classifyError,
  releaseLock,
  writeJsonAtomic,
} = require('../client/sync-runtime');
const { intervalMinutes, serverOrigin, windowsTaskDefinitions } = require('../client/sync-scheduler');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-sync-runtime-'));
}

test('동시에 시작한 sync는 활성 PID 잠금으로 한 프로세스만 진입한다', () => {
  const lock = path.join(tempDir(), 'sync.lock');
  assert.strictEqual(acquireLock(lock), true);
  assert.strictEqual(acquireLock(lock), false);
  releaseLock(lock);
  assert.ok(!fs.existsSync(lock));
});

test('종료된 프로세스의 stale lock은 다음 실행이 복구한다', () => {
  const lock = path.join(tempDir(), 'sync.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString() }));
  assert.strictEqual(acquireLock(lock), true);
  releaseLock(lock);
});

test('작성 중인 잠금은 보호하고 오래된 손상 잠금만 복구한다', () => {
  const lock = path.join(tempDir(), 'sync.lock');
  fs.writeFileSync(lock, '');
  assert.strictEqual(acquireLock(lock, { staleMs: 60000 }), false);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  assert.strictEqual(acquireLock(lock, { staleMs: 60000 }), true);
  releaseLock(lock);
});

test('JSON 갱신은 같은 디렉터리 임시 파일을 원자적으로 교체한다', () => {
  const dir = tempDir();
  const file = path.join(dir, 'auth.json');
  writeJsonAtomic(file, { accessToken: 'not-a-real-token', count: 1 }, 0o600);
  writeJsonAtomic(file, { accessToken: 'not-a-real-token', count: 2 }, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).count, 2);
  assert.deepStrictEqual(fs.readdirSync(dir), ['auth.json']);
});

test('네트워크 오류 안내에는 URL·토큰·경로가 노출되지 않는다', () => {
  const error = new TypeError('fetch failed for http://secret/path?token=value');
  const safe = classifyError(error);
  assert.strictEqual(safe.code, 'NETWORK_UNAVAILABLE');
  assert.doesNotMatch(safe.message, /secret|token|http|path/);
});

test('Windows 작업은 주기 실행과 로그인 실행을 모두 등록한다', () => {
  const definitions = windowsTaskDefinitions({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    launcher: 'C:\\clawad\\client\\scheduled-sync.js',
    data: 'C:\\clawad\\data',
    interval: 5,
  });
  assert.strictEqual(definitions.length, 2);
  assert.ok(definitions.some(({ args }) => args.includes('MINUTE') && args.includes('5')));
  assert.ok(definitions.some(({ args }) => args.includes('ONLOGON')));
  assert.ok(definitions.every(({ args }) => args.includes('LIMITED')));
  assert.ok(definitions.every(({ args }) => args.includes('/IT') && args.includes('/RU')));
});

test('주기 작업만 필수이고 로그온 작업은 선택으로 표시한다', () => {
  const definitions = windowsTaskDefinitions({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    launcher: 'C:\\clawad\\client\\scheduled-sync.js',
    data: 'C:\\clawad\\data',
    interval: 5,
  });
  const interval = definitions.find(({ args }) => args.includes('MINUTE'));
  const logon = definitions.find(({ args }) => args.includes('ONLOGON'));
  assert.strictEqual(interval.optional, false, '주기 sync 작업은 실패 시 롤백해야 한다.');
  assert.strictEqual(logon.optional, true, '로그온 작업은 권한 부족으로 실패해도 설치를 막지 않는다.');
});

test('자동 sync 주기는 Windows 작업 스케줄러 허용 범위로 제한한다', () => {
  assert.strictEqual(intervalMinutes('1'), 1);
  assert.strictEqual(intervalMinutes('1439'), 1439);
  assert.throws(() => intervalMinutes('0'), /1~1439/);
  assert.throws(() => intervalMinutes('1440'), /1~1439/);
});

test('예약 실행에는 비밀값 없는 HTTP(S) 서버 origin만 저장한다', () => {
  assert.strictEqual(serverOrigin('https://api.example.test/'), 'https://api.example.test');
  assert.throws(() => serverOrigin('https://user:secret@example.test'), /자격증명/);
  assert.throws(() => serverOrigin('https://api.example.test/?token=secret'), /자격증명/);
  assert.throws(() => serverOrigin('file:///tmp/socket'), /HTTP/);
});
