'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireLock,
  classifyError,
  lockHeldByLiveOwner,
  releaseLock,
  writeJsonAtomic,
} = require('../client/sync-runtime');
const { intervalMinutes, probeWindowsHiddenHost, serverOrigin, windowsShimSource, windowsTaskDefinitions } = require('../client/sync-scheduler');

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

// --- 서피스 락 읽기 전용 판정 (CLAW-91) ---

test('서피스 락 판정은 파일이 없으면 미보유다', () => {
  assert.strictEqual(lockHeldByLiveOwner(path.join(tempDir(), 'surface.lock')), false);
});

test('살아 있는 소유자의 락은 오래돼도 보유로 본다', () => {
  const lock = path.join(tempDir(), 'surface.lock');
  // 상주 오버레이는 락을 며칠 들고 있다. 나이로 만료시키면 이중 표시·이중 계상이 된다.
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: longAgo, owner: 'overlay' }));
  assert.strictEqual(lockHeldByLiveOwner(lock), true);
});

test('죽은 소유자의 락은 stale로 보아 미보유다 — 광고가 영구히 사라지지 않는다', () => {
  const lock = path.join(tempDir(), 'surface.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 0x7ffffffe, startedAt: new Date().toISOString() }));
  assert.strictEqual(lockHeldByLiveOwner(lock), false);
});

test('소유자를 알 수 없는 락은 최근 것만 보유로 본다', () => {
  const dir = tempDir();
  const fresh = path.join(dir, 'fresh.lock');
  fs.writeFileSync(fresh, JSON.stringify({ startedAt: new Date().toISOString() }));
  assert.strictEqual(lockHeldByLiveOwner(fresh), true);

  const old = path.join(dir, 'old.lock');
  fs.writeFileSync(old, JSON.stringify({ startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
  assert.strictEqual(lockHeldByLiveOwner(old), false);

  // 손상된 JSON도 크래시 없이 mtime 기준으로 판정한다.
  const broken = path.join(dir, 'broken.lock');
  fs.writeFileSync(broken, '{not json');
  assert.strictEqual(lockHeldByLiveOwner(broken), true);
  assert.strictEqual(lockHeldByLiveOwner(broken, { now: Date.now() + 60 * 60 * 1000 }), false);
});

test('서피스 락 판정은 락을 지우거나 가져가지 않는다', () => {
  const lock = path.join(tempDir(), 'surface.lock');
  const body = JSON.stringify({ pid: 0x7ffffffe, startedAt: new Date().toISOString() });
  fs.writeFileSync(lock, body);
  // stale로 판정되는 경우에도 비소유자는 파일을 건드리지 않는다.
  assert.strictEqual(lockHeldByLiveOwner(lock), false);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), body);
});

// --- Windows 콘솔 창 숨김 (주기 sync가 창을 띄우지 않는다) ---

const WIN_CTX = {
  node: String.raw`C:\node.exe`,
  launcher: String.raw`C:\clawad\scheduled-sync.js`,
  data: String.raw`C:\data`,
  interval: 5,
};

test('conhost를 쓸 수 있으면 태스크가 창 없는 호스트로 node를 실행한다', () => {
  for (const { args } of windowsTaskDefinitions({ ...WIN_CTX, hiddenHost: 'conhost' })) {
    const command = args[args.indexOf('/TR') + 1];
    assert.match(command, /^conhost\.exe --headless /, '창 없는 호스트로 감싸야 한다');
    assert.ok(command.includes(WIN_CTX.launcher), '런처 경로가 유지돼야 한다');
  }
});

test('wscript 셤을 쓰면 태스크가 셤만 실행하고 셤이 창을 숨긴다', () => {
  const shimPath = String.raw`C:\data\sync-hidden.vbs`;
  const ctx = { ...WIN_CTX, hiddenHost: 'wscript', shim: shimPath };
  for (const { args } of windowsTaskDefinitions(ctx)) {
    const command = args[args.indexOf('/TR') + 1];
    assert.strictEqual(command, `wscript.exe //nologo "${shimPath}"`);
  }
  const shim = windowsShimSource(ctx);
  assert.match(shim, /WScript\.Shell/);
  assert.match(shim, /, 0, False/, '창 숨김 인자 0이 있어야 한다');
  assert.ok(shim.includes(ctx.launcher), '런처 경로가 셤에 들어가야 한다');
});

test('창 없는 호스트를 못 찾으면 기존 직접 실행으로 되돌아간다 — sync는 계속 동작한다', () => {
  for (const { args } of windowsTaskDefinitions({ ...WIN_CTX, hiddenHost: null })) {
    const command = args[args.indexOf('/TR') + 1];
    assert.strictEqual(command, `"${WIN_CTX.node}" "${WIN_CTX.launcher}" "${WIN_CTX.data}"`);
  }
});

test('창 없는 호스트 탐지는 실제 실행 결과로 판단한다', () => {
  const calls = [];
  const failConhost = (command) => {
    calls.push(command);
    return command === 'conhost.exe' ? { status: 1 } : { status: 0 };
  };
  assert.strictEqual(probeWindowsHiddenHost(WIN_CTX, failConhost), 'wscript', 'conhost 실패 시 wscript로 내려간다');
  assert.deepStrictEqual(calls, ['conhost.exe', 'wscript.exe']);
  assert.strictEqual(probeWindowsHiddenHost(WIN_CTX, () => ({ status: 0 })), 'conhost', 'conhost가 되면 먼저 쓴다');
  assert.strictEqual(probeWindowsHiddenHost(WIN_CTX, () => ({ error: new Error('없음') })), null, '둘 다 없으면 null');
});
