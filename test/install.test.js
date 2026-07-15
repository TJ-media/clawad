'use strict';
// install.js 스모크 (CLAW-24 §설치 UX) — 백업·원상복구·일시중지.
// 사용자의 실제 settings.json을 건드리지 않도록 CLAWAD_SETTINGS로 격리한다.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL = path.join(__dirname, '..', 'client', 'install.js');

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
  };
}

const run = (env, cmd) => spawnSync('node', [INSTALL, cmd], { env, encoding: 'utf8' });
const settingsOf = (env) => JSON.parse(fs.readFileSync(env.CLAWAD_SETTINGS, 'utf8'));

test('설치는 변경 내용을 고지하고 statusLine을 설정한다', () => {
  const env = makeEnv({});
  const r = run(env, 'install');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /다음이 변경됩니다/);
  assert.match(r.stdout, /수집하지 않습니다/);
  assert.match(r.stdout, /자동 sync 등록 완료/);
  assert.match(settingsOf(env).statusLine.command, /statusline-wrapper\.js/);
  assert.match(settingsOf(env).statusLine.command, new RegExp(path.basename(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.strictEqual(settingsOf(env).statusLine.refreshInterval, 1000);
  assert.match(JSON.stringify(settingsOf(env).hooks), /work-activity\.js.*start/);
  assert.match(JSON.stringify(settingsOf(env).hooks), /work-activity\.js.*stop/);
  assert.ok(settingsOf(env).hooks.StopFailure);
  assert.ok(settingsOf(env).hooks.SessionEnd);
});

test('기존 statusLine을 백업하고 제거 시 원상복구한다', () => {
  const original = { type: 'command', command: 'my-custom-statusline' };
  const env = makeEnv({ statusLine: original, otherSetting: 'keep-me' });

  run(env, 'install');
  assert.match(settingsOf(env).statusLine.command, /statusline-wrapper\.js/);

  const r = run(env, 'uninstall');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(settingsOf(env).statusLine, original, '기존 설정이 그대로 복구돼야 한다');
  assert.strictEqual(settingsOf(env).otherSetting, 'keep-me', '다른 설정을 건드리면 안 된다');
});

test('설치 전에 statusLine이 없었으면 제거 시 항목을 지운다', () => {
  const env = makeEnv({ otherSetting: 'keep-me' });
  run(env, 'install');
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
  // 백업이 클로애드 명령으로 덮어써졌다면 원상복구가 깨진다.
  assert.strictEqual(settingsOf(env).statusLine.command, 'my-custom-statusline');
});

test('새 패키지 경로로 재설치하면 최초 백업을 보존하고 명령 경로만 교체한다', () => {
  const original = { type: 'command', command: 'my-custom-statusline' };
  const env = makeEnv({ statusLine: original });
  run(env, 'install');
  const first = settingsOf(env).statusLine.command;
  const moved = first.replace(/statusline-wrapper\.js/, `elsewhere${path.sep}statusline-wrapper.js`);
  const settings = settingsOf(env);
  settings.statusLine.command = moved;
  fs.writeFileSync(env.CLAWAD_SETTINGS, JSON.stringify(settings));

  assert.strictEqual(run(env, 'install').status, 0);
  assert.strictEqual(settingsOf(env).statusLine.command, first);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(env.CLAWAD_DATA, 'statusline-backup.json'), 'utf8')).statusLine, original);
  assert.strictEqual(run(env, 'uninstall').status, 0);
  assert.deepStrictEqual(settingsOf(env).statusLine, original);
});

test('pause/resume이 일시중지 파일을 만들고 지운다', () => {
  const env = makeEnv({});
  const pauseFile = path.join(env.CLAWAD_DATA, 'paused');

  run(env, 'install');
  run(env, 'pause');
  assert.ok(fs.existsSync(pauseFile));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(env.CLAWAD_DATA, 'sync-schedule.json'))).paused, true);

  run(env, 'resume');
  assert.ok(!fs.existsSync(pauseFile));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(env.CLAWAD_DATA, 'sync-schedule.json'))).paused, false);
});

test('기존 로그인 정보가 있으면 설치 직후 최초 sync를 요청한다', () => {
  const env = makeEnv({});
  fs.mkdirSync(env.CLAWAD_DATA, { recursive: true });
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'auth.json'), '{}');
  const result = run(env, 'install');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /최초 광고 준비 동기화/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(env.CLAWAD_DATA, 'preparation-state.json'), 'utf8')).state, 'SYNCING');
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

    const schedule = JSON.parse(fs.readFileSync(path.join(env.CLAWAD_DATA, 'sync-schedule.json'), 'utf8'));
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
    assert.ok(!fs.existsSync(path.join(env.CLAWAD_DATA, 'sync-schedule.json')));
  });
}

test('자동 sync 등록 실패 시 새 statusLine과 백업을 되돌린다', () => {
  const env = makeEnv({ otherSetting: 'keep-me' }, 'unsupported-os');
  const result = run(env, 'install');
  assert.strictEqual(result.status, 1);
  assert.deepStrictEqual(settingsOf(env), { otherSetting: 'keep-me' });
  assert.ok(!fs.existsSync(path.join(env.CLAWAD_DATA, 'statusline-backup.json')));
});

test('기존 clawad 직접 명령의 wrapper 전환 실패 시 설치 전 설정으로 되돌린다', () => {
  const legacy = { type: 'command', command: `"${process.execPath}" "C:\\clawad\\client\\statusline.js"` };
  const original = { type: 'command', command: 'my-original-statusline' };
  const env = makeEnv({ statusLine: legacy, otherSetting: 'keep-me' }, 'unsupported-os');
  fs.mkdirSync(env.CLAWAD_DATA, { recursive: true });
  fs.writeFileSync(path.join(env.CLAWAD_DATA, 'statusline-backup.json'), JSON.stringify({ hadStatusLine: true, statusLine: original }));

  const result = run(env, 'install');
  assert.strictEqual(result.status, 1);
  assert.deepStrictEqual(settingsOf(env), { statusLine: legacy, otherSetting: 'keep-me' });
  assert.ok(fs.existsSync(path.join(env.CLAWAD_DATA, 'statusline-backup.json')));
  assert.ok(!fs.existsSync(path.join(env.CLAWAD_DATA, 'statusline-composition.json')));
});

test('알 수 없는 명령은 사용법을 출력하고 exit 1', () => {
  const env = makeEnv({});
  const r = run(env, 'bogus');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /사용법/);
});
