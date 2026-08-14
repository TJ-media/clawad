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
const { intervalMinutes, probeWindowsHiddenHost, serverOrigin, windowsAction, windowsShimSource, windowsTaskXml } = require('../client/sync-scheduler');

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

// 기본 권한으로 쓴 뒤 chmod하면 그 사이 POSIX에서 토큰이 전체 읽기 가능한 경합 창이 생긴다.
// 생성 시점에 권한을 주면 그 창이 없다 — umask는 비트를 빼기만 하지 더하지 못한다 (CLAW-183).
test('mode를 준 원자적 쓰기는 생성 시점부터 권한이 좁다 (CLAW-183)', () => {
  const dir = tempDir();
  const file = path.join(dir, 'auth.json');
  writeJsonAtomic(file, { refreshToken: 'not-a-real-token' }, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir), ['auth.json'], '임시 파일이 남으면 안 된다');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('네트워크 오류 안내에는 URL·토큰·경로가 노출되지 않는다', () => {
  const error = new TypeError('fetch failed for http://secret/path?token=value');
  const safe = classifyError(error);
  assert.strictEqual(safe.code, 'NETWORK_UNAVAILABLE');
  assert.doesNotMatch(safe.message, /secret|token|http|path/);
});

// 배터리로 돌면 sync가 아예 실행되지 않던 결함 (CLAW-205). schtasks 명령행으로는 전원 조건을
// 설정할 수 없어 작업 XML로 등록한다. 트리거 두 개도 같은 작업에 담아 로그온 전용 작업을 없앴다.
const XML_CTX = {
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  launcher: String.raw`C:\clawad\client\scheduled-sync.js`,
  data: String.raw`C:\clawad\data`,
  interval: 5,
};

test('작업 XML은 배터리 전원에서도 실행되게 한다 (CLAW-205)', () => {
  const xml = windowsTaskXml(XML_CTX);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/, '배터리에서 시작을 막으면 안 된다');
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/, '배터리로 바뀌어도 멈추면 안 된다');
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/, '잠자기로 놓친 실행을 따라잡아야 한다');
});

test('작업 XML은 주기와 로그온 트리거를 한 작업에 담는다 (CLAW-205)', () => {
  const xml = windowsTaskXml(XML_CTX);
  assert.match(xml, /<LogonTrigger>/, '로그온 트리거가 있어야 한다');
  assert.match(xml, /<Interval>PT5M<\/Interval>/, '주기가 반영돼야 한다');
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/, '관리자 권한으로 올리지 않는다');
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/, '로그온한 사용자로만 돈다');
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/, 'sync가 겹쳐 쌓이면 안 된다');
});

test('작업 XML은 경로의 특수문자를 이스케이프한다', () => {
  const xml = windowsTaskXml({ ...XML_CTX, data: String.raw`C:\a & b\<data>` });
  assert.match(xml, /&amp;/, '앰퍼샌드는 이스케이프돼야 한다');
  assert.match(xml, /&lt;data&gt;/, '꺾쇠는 이스케이프돼야 한다');
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)[1];
  assert.ok(!/[<>]/.test(args), '인자에 생 꺾쇠가 남으면 XML이 깨진다');
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
  const action = windowsAction({ ...WIN_CTX, hiddenHost: 'conhost' });
  assert.strictEqual(action.command, 'conhost.exe', '창 없는 호스트가 실행 파일이어야 한다');
  assert.match(action.args, /^--headless /);
  assert.ok(action.args.includes(WIN_CTX.launcher), '런처 경로가 유지돼야 한다');
});

test('wscript 셤을 쓰면 태스크가 셤만 실행하고 셤이 창을 숨긴다', () => {
  const shimPath = String.raw`C:\data\sync-hidden.vbs`;
  const ctx = { ...WIN_CTX, hiddenHost: 'wscript', shim: shimPath };
  const action = windowsAction(ctx);
  assert.strictEqual(action.command, 'wscript.exe');
  assert.strictEqual(action.args, `//nologo "${shimPath}"`);
  const shim = windowsShimSource(ctx);
  assert.match(shim, /WScript\.Shell/);
  assert.match(shim, /, 0, False/, '창 숨김 인자 0이 있어야 한다');
  assert.ok(shim.includes(ctx.launcher), '런처 경로가 셤에 들어가야 한다');
});

test('창 없는 호스트를 못 찾으면 기존 직접 실행으로 되돌아간다 — sync는 계속 동작한다', () => {
  const action = windowsAction({ ...WIN_CTX, hiddenHost: null });
  assert.strictEqual(action.command, WIN_CTX.node);
  assert.strictEqual(action.args, `"${WIN_CTX.launcher}" "${WIN_CTX.data}"`);
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

// schtasks는 BOM이 붙은 UTF-16LE만 받는다. 없으면 "루트 요소가 하나입니다"로 거부하고,
// Node의 'utf16le' 인코딩은 BOM을 넣지 않는다 — 실제로 이 실수로 등록이 실패했다 (CLAW-205).
test('작업 XML은 BOM으로 시작한다 (CLAW-205)', () => {
  const xml = windowsTaskXml(XML_CTX);
  assert.strictEqual(xml.charCodeAt(0), 0xFEFF, 'BOM이 없으면 schtasks가 XML을 거부한다');
  assert.match(xml.slice(1), /^<\?xml version="1\.0" encoding="UTF-16"\?>/, 'BOM 뒤에 선언이 와야 한다');
  // 파일로 쓴 바이트에도 BOM이 남아야 한다.
  const bytes = Buffer.from(xml, 'utf16le');
  assert.strictEqual(bytes[0], 0xFF);
  assert.strictEqual(bytes[1], 0xFE);
});
