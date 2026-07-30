'use strict';
// install.js 스모크 (CLAW-24 §설치 UX) — 훅 등록·원상복구·일시중지.
// 광고 표시는 오버레이 앱이 전담하므로 clawad는 statusLine 슬롯을 점유하지 않는다 (CLAW-134).
// 사용자의 실제 settings.json을 건드리지 않도록 CLAWAD_SETTINGS로 격리한다.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL = path.join(__dirname, '..', 'client', 'install.js');
/** 0.1.11까지 우리가 등록하던 statusLine. 마이그레이션 입력으로만 쓴다. */
const LEGACY_STATUSLINE = { type: 'command', command: `"${process.execPath}" "C:\\clawad\\client\\statusline-wrapper.js"`, refreshInterval: 1 };

function makeEnv(existingSettings, platform = process.platform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-install-'));
  const settings = path.join(dir, 'settings.json');
  if (existingSettings !== undefined) fs.writeFileSync(settings, JSON.stringify(existingSettings, null, 2));
  return {
    ...process.env,
    CLAWAD_DATA: path.join(dir, 'data'),
    CLAWAD_SETTINGS: settings,
    CLAWAD_PLATFORM: platform,
    CLAWAD_SCHEDULER_DRY_RUN: '1',
    CLAWAD_SYNC_INTERVAL_MINUTES: '7',
    CLAWAD_SERVER: 'https://api.clawad.test',
    CLAWAD_INITIAL_SYNC_DRY_RUN: '1',
    // 오버레이 설치 탐지가 표준 경로(%LOCALAPPDATA%\Programs\Claw-Ad)를 보므로 격리한다.
    // 이걸 두지 않으면 개발자 PC에 오버레이가 깔려 있느냐에 따라 결과가 달라진다.
    LOCALAPPDATA: path.join(dir, 'localappdata'),
  };
}

const run = (env, cmd) => spawnSync('node', [INSTALL, cmd], { env, encoding: 'utf8' });
const settingsOf = (env) => JSON.parse(fs.readFileSync(env.CLAWAD_SETTINGS, 'utf8'));
const dataFile = (env, name) => path.join(env.CLAWAD_DATA, name);

test('설치는 변경 내용을 고지하고 활동 감지 훅만 등록한다 (CLAW-134)', () => {
  const env = makeEnv({});
  const r = run(env, 'install');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /다음이 변경됩니다/);
  assert.match(r.stdout, /서버로 전송하지 않습니다/);
  assert.match(r.stdout, /이 CLI는 statusLine 설정을 건드리지 않습니다/);
  assert.match(r.stdout, /자동 sync 등록 완료/);
  assert.ok(!('statusLine' in settingsOf(env)), 'clawad는 statusLine 슬롯을 점유하지 않는다');
  assert.match(JSON.stringify(settingsOf(env).hooks), /work-activity\.js.*start/);
  assert.match(JSON.stringify(settingsOf(env).hooks), /work-activity\.js.*stop/);
  assert.ok(settingsOf(env).hooks.StopFailure);
  assert.ok(settingsOf(env).hooks.SessionEnd);
});

test('사용자의 기존 statusLine은 설치·제거 어느 쪽에서도 건드리지 않는다 (CLAW-134)', () => {
  const original = { type: 'command', command: 'my-custom-statusline' };
  const env = makeEnv({ statusLine: original, otherSetting: 'keep-me' });

  assert.strictEqual(run(env, 'install').status, 0);
  assert.deepStrictEqual(settingsOf(env).statusLine, original, '남의 statusLine을 가로채면 안 된다');
  assert.ok(!fs.existsSync(dataFile(env, 'statusline-backup.json')), '가져가지 않았으므로 백업할 것도 없다');

  assert.strictEqual(run(env, 'uninstall').status, 0);
  assert.deepStrictEqual(settingsOf(env).statusLine, original);
  assert.strictEqual(settingsOf(env).otherSetting, 'keep-me', '다른 설정을 건드리면 안 된다');
  assert.ok(!settingsOf(env).hooks, '제거 시 활동 감지 훅은 사라져야 한다');
});

test('설치는 statusLine 항목을 새로 만들지 않는다 (CLAW-134)', () => {
  const env = makeEnv({ otherSetting: 'keep-me' });
  run(env, 'install');
  assert.ok(!('statusLine' in settingsOf(env)));
  run(env, 'uninstall');
  const settings = settingsOf(env);
  assert.ok(!('statusLine' in settings));
  assert.strictEqual(settings.otherSetting, 'keep-me');
});

test('클로애드 설정이 아니면 제거가 아무것도 건드리지 않는다', () => {
  const other = { type: 'command', command: 'someone-elses-statusline' };
  const env = makeEnv({ statusLine: other });
  const r = run(env, 'uninstall');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /건드리지 않습니다/);
  assert.deepStrictEqual(settingsOf(env).statusLine, other);
});

test('중복 설치는 기존 설정을 덮어쓰지 않는다', () => {
  const env = makeEnv({ statusLine: { type: 'command', command: 'my-custom-statusline' } });
  run(env, 'install');
  run(env, 'install'); // 두 번째 설치 시도
  run(env, 'uninstall');
  assert.strictEqual(settingsOf(env).statusLine.command, 'my-custom-statusline');
});

// 0.1.11 이하에서 올라오는 사용자. 우리가 쥐고 있던 슬롯을 설치 전 값으로 되돌려야 한다(rules §7).
test('이전 버전이 점유한 statusLine을 설치 시 원상복구한다 (CLAW-134)', () => {
  const original = { type: 'command', command: 'my-original-statusline' };
  const env = makeEnv({ statusLine: LEGACY_STATUSLINE, otherSetting: 'keep-me' });
  fs.mkdirSync(env.CLAWAD_DATA, { recursive: true });
  fs.writeFileSync(dataFile(env, 'statusline-backup.json'), JSON.stringify({ hadStatusLine: true, statusLine: original }));
  fs.writeFileSync(dataFile(env, 'statusline-composition.json'), JSON.stringify({ version: 1, originalCommand: original.command }));

  const r = run(env, 'install');
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /원상복구했습니다/);
  assert.deepStrictEqual(settingsOf(env).statusLine, original);
  assert.strictEqual(settingsOf(env).otherSetting, 'keep-me');
  // 슬롯을 다시 점유하는 코드가 없으므로 백업·조합 상태는 소비한다.
  assert.ok(!fs.existsSync(dataFile(env, 'statusline-backup.json')));
  assert.ok(!fs.existsSync(dataFile(env, 'statusline-composition.json')));
});

test('설치 전에 statusLine이 없던 사용자는 슬롯을 비운 채로 남는다 (CLAW-134)', () => {
  const env = makeEnv({ statusLine: LEGACY_STATUSLINE });
  fs.mkdirSync(env.CLAWAD_DATA, { recursive: true });
  fs.writeFileSync(dataFile(env, 'statusline-backup.json'), JSON.stringify({ hadStatusLine: false, statusLine: null }));

  const r = run(env, 'install');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /설치 전에도 없었음/);
  assert.ok(!('statusLine' in settingsOf(env)));
});

test('설치를 거치지 않고 제거해도 이전 버전의 statusLine을 원상복구한다 (CLAW-134)', () => {
  const original = { type: 'command', command: 'my-original-statusline' };
  const env = makeEnv({ statusLine: LEGACY_STATUSLINE });
  fs.mkdirSync(env.CLAWAD_DATA, { recursive: true });
  fs.writeFileSync(dataFile(env, 'statusline-backup.json'), JSON.stringify({ hadStatusLine: true, statusLine: original }));

  const r = run(env, 'uninstall');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(settingsOf(env).statusLine, original);
  assert.ok(!fs.existsSync(dataFile(env, 'statusline-backup.json')));
});

test('pause/resume이 일시중지 파일을 만들고 지운다', () => {
  const env = makeEnv({});
  const pauseFile = dataFile(env, 'paused');

  run(env, 'install');
  run(env, 'pause');
  assert.ok(fs.existsSync(pauseFile));
  assert.strictEqual(JSON.parse(fs.readFileSync(dataFile(env, 'sync-schedule.json'))).paused, true);

  run(env, 'resume');
  assert.ok(!fs.existsSync(pauseFile));
  assert.strictEqual(JSON.parse(fs.readFileSync(dataFile(env, 'sync-schedule.json'))).paused, false);
});

// 오버레이는 별도 프로그램이라 우리 `paused` 파일을 읽지 않는다. 재고를 비우지 않으면
// 일시중지해도 캐시가 마를 때까지 광고가 계속 뜬다 (rules §7).
test('일시중지는 받아둔 광고 재고를 비운다 (CLAW-134)', () => {
  const env = makeEnv({});
  run(env, 'install');
  const bundles = dataFile(env, 'bundles.json');
  fs.writeFileSync(bundles, JSON.stringify([
    { serveToken: 'a', expiresAt: Date.now() + 600000, ad: { text: '광고1' } },
    { serveToken: 'b', expiresAt: Date.now() + 600000, ad: { text: '광고2' } },
  ]));

  const r = run(env, 'pause');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /받아둔 광고 2건을 폐기했습니다/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(bundles, 'utf8')), []);
});

test('일시중지·서피스 락 상태에서도 설치가 성공한다 (CLAW-131 회귀)', () => {
  for (const prepare of [
    (env) => fs.writeFileSync(dataFile(env, 'paused'), new Date().toISOString()),
    (env) => fs.writeFileSync(dataFile(env, 'surface.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'overlay' })),
  ]) {
    const env = makeEnv({});
    fs.mkdirSync(env.CLAWAD_DATA, { recursive: true });
    prepare(env);
    const result = run(env, 'install');
    assert.strictEqual(result.status, 0, `설치가 실패했다: ${result.stdout}${result.stderr}`);
  }
});

test('기존 로그인 정보가 있으면 설치 직후 최초 sync를 요청한다', () => {
  const env = makeEnv({});
  fs.mkdirSync(env.CLAWAD_DATA, { recursive: true });
  fs.writeFileSync(dataFile(env, 'auth.json'), '{}');
  const result = run(env, 'install');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /최초 광고 준비 동기화/);
  assert.strictEqual(JSON.parse(fs.readFileSync(dataFile(env, 'preparation-state.json'), 'utf8')).state, 'SYNCING');
});

test('workspace trust가 명시적으로 없으면 해결 가능한 진단을 반환한다', () => {
  const env = { ...makeEnv({}), CLAWAD_WORKSPACE_TRUSTED: '0' };
  const result = run(env, 'install');
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /WORKSPACE_TRUST/);
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} 자동 sync 설치·상태·재설치·제거가 멱등이다`, () => {
    const env = makeEnv({}, platform);
    assert.strictEqual(run(env, 'install').status, 0);
    assert.strictEqual(run(env, 'install').status, 0);

    const schedule = JSON.parse(fs.readFileSync(dataFile(env, 'sync-schedule.json'), 'utf8'));
    assert.strictEqual(schedule.platform, platform);
    assert.strictEqual(schedule.intervalMinutes, 7);
    assert.strictEqual(schedule.server, 'https://api.clawad.test');

    const statusResult = run(env, 'status');
    assert.strictEqual(statusResult.status, 0);
    assert.match(statusResult.stdout, /자동 sync: 등록됨/);

    if (platform === 'darwin') {
      const plist = fs.readFileSync(path.join(env.CLAWAD_DATA, 'scheduler-preview', 'ai.clawad.sync.plist'), 'utf8');
      assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
      assert.match(plist, /<key>StartInterval<\/key><integer>420<\/integer>/);
    }
    if (platform === 'linux') {
      const timer = fs.readFileSync(path.join(env.CLAWAD_DATA, 'scheduler-preview', 'clawad-sync.timer'), 'utf8');
      assert.match(timer, /OnStartupSec=30s/);
      assert.match(timer, /OnUnitActiveSec=7min/);
    }

    assert.strictEqual(run(env, 'uninstall').status, 0);
    assert.ok(!fs.existsSync(dataFile(env, 'sync-schedule.json')));
  });
}

test('자동 sync 등록 실패 시 등록한 훅을 되돌린다', () => {
  const env = makeEnv({ otherSetting: 'keep-me' }, 'unsupported-os');
  const result = run(env, 'install');
  assert.strictEqual(result.status, 1);
  assert.deepStrictEqual(settingsOf(env), { otherSetting: 'keep-me' });
});

test('자동 sync 등록 실패 시 statusLine 복구를 되돌리고 백업을 보존한다 (CLAW-134)', () => {
  const original = { type: 'command', command: 'my-original-statusline' };
  const env = makeEnv({ statusLine: LEGACY_STATUSLINE, otherSetting: 'keep-me' }, 'unsupported-os');
  fs.mkdirSync(env.CLAWAD_DATA, { recursive: true });
  fs.writeFileSync(dataFile(env, 'statusline-backup.json'), JSON.stringify({ hadStatusLine: true, statusLine: original }));

  const result = run(env, 'install');
  assert.strictEqual(result.status, 1);
  assert.deepStrictEqual(settingsOf(env), { statusLine: LEGACY_STATUSLINE, otherSetting: 'keep-me' });
  // 백업이 사라지면 다음 설치가 원래 값을 되돌릴 수 없다.
  assert.ok(fs.existsSync(dataFile(env, 'statusline-backup.json')));
});

test('status는 이전 버전이 점유 중인 statusLine을 알려준다 (CLAW-134)', () => {
  const env = makeEnv({ statusLine: LEGACY_STATUSLINE });
  const result = run(env, 'status');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /statusLine: 이전 버전이 점유 중/);
  assert.match(result.stdout, /설치됨   : 아니오/);
});

test('status는 설치 여부를 활동 감지 훅으로 판단하고 광고 창구를 알려준다 (CLAW-134)', () => {
  const env = makeEnv({});
  run(env, 'install');
  const result = run(env, 'status');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /설치됨   : 예/);
  assert.match(result.stdout, /광고 표시: 데스크탑 오버레이 앱 \(확인되지 않음/);
  assert.doesNotMatch(result.stdout, /statusLine: 이전 버전이 점유 중/);
});

test('status는 표준 경로에 설치된 오버레이를 인정한다 (CLAW-134)', () => {
  const env = makeEnv({});
  run(env, 'install');
  const exe = path.join(env.LOCALAPPDATA, 'Programs', 'Claw-Ad', 'Claw-Ad.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  const result = run(env, 'status');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /광고 표시: 데스크탑 오버레이 앱 \(확인됨\)/);
});

// 표준 설치 경로 밖에서 실행하는 오버레이(개발 빌드 등)를 "없음"으로 잘못 보고하지 않는다.
test('status는 살아 있는 서피스 소유자를 광고 창구로 인정한다 (CLAW-134)', () => {
  const env = makeEnv({});
  run(env, 'install');
  fs.writeFileSync(dataFile(env, 'surface.lock'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'overlay' }));
  const result = run(env, 'status');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /광고 표시: 데스크탑 오버레이 앱 \(확인됨\)/);
});

test('알 수 없는 명령은 사용법을 출력하고 exit 1', () => {
  const env = makeEnv({});
  const r = run(env, 'bogus');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /사용법/);
});
