'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeJsonAtomic } = require('./sync-runtime');
const { defaultDataDir, serverOrigin: configuredServerOrigin } = require('./distribution-config');

// Windows는 작업 하나에 주기·로그온 트리거를 함께 담는다 (CLAW-205). 0.1.21 이하는 두 개로
// 나눠 등록했고 로그온 쪽은 비관리자 권한에서 거부됐다 — 그 이름은 제거 대상으로만 남긴다.
const WINDOWS_INTERVAL_TASK = 'Clawad-Sync-Interval';
const WINDOWS_LOGON_TASK = 'Clawad-Sync-Logon';
const WINDOWS_TASKS = [WINDOWS_INTERVAL_TASK, WINDOWS_LOGON_TASK];
const MAC_LABEL = 'ai.clawad.sync';
const LINUX_TIMER = 'clawad-sync.timer';

function userId() {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

function intervalMinutes(value) {
  const parsed = Number(value || 5);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1439) {
    throw new Error('CLAWAD_SYNC_INTERVAL_MINUTES는 1~1439 사이 정수여야 합니다.');
  }
  return parsed;
}

function serverOrigin(value) {
  let url;
  try { url = new URL(value || 'http://localhost:3000'); } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CLAWAD_SERVER는 자격증명·쿼리·해시가 없는 HTTP(S) 주소여야 합니다.');
  }
  return url.origin;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unitQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// 스케줄러 명령의 실패 원인(권한 거부 등)은 사용자가 직접 진단해야 하므로 원문을 그대로 덧붙인다.
// 인자에는 경로만 담기고 비밀값이 없어 노출해도 안전하다.
function failureDetail(result) {
  if (result.error) return result.error.message;
  return `${result.stderr || ''}${result.stdout || ''}`.trim();
}

function run(command, args, options = {}) {
  if (options.dryRun) return { status: 0, stdout: '' };
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  // allowFailure는 spawn 오류(도구 부재 등)도 허용한다 — 롤백·해제 경로가 중간에 끊기면
  // 뒤따르는 파일 정리까지 건너뛰게 된다 (CLAW-196).
  if ((result.error || result.status !== 0) && !options.allowFailure) {
    const message = options.message || '자동 sync 작업을 설정하지 못했습니다.';
    const detail = failureDetail(result);
    throw new Error(detail ? `${message} (${command}: ${detail})` : message);
  }
  return result;
}

// OS 스케줄러 이름공간은 전역이라 CLAWAD_DATA 격리로 보호되지 않는다. 데이터 경로가 기본
// 위치가 아니면(테스트·검증 스크립트) 실 기기 태스크를 조작하지 못하게 dry-run이 기본값이다.
// 실사용 설치는 항상 기본 경로를 쓰므로 영향이 없고, 격리 상태에서 실제 조작이 필요하면
// CLAWAD_SCHEDULER_DRY_RUN=0을 명시한다 (CLAW-194).
let isolationNoticeShown = false;
function schedulerDryRunDefault(data) {
  const explicit = process.env.CLAWAD_SCHEDULER_DRY_RUN;
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  if (path.resolve(data) === path.resolve(defaultDataDir())) return false;
  if (!isolationNoticeShown) {
    isolationNoticeShown = true;
    console.error(
      '데이터 경로가 기본 위치가 아니라 OS 스케줄러 조작을 건너뜁니다(dry-run). ' +
        '실제로 조작하려면 CLAWAD_SCHEDULER_DRY_RUN=0을 설정하세요.',
    );
  }
  return true;
}

function context(options = {}) {
  const root = options.root || path.join(__dirname, '..');
  const data = options.data || process.env.CLAWAD_DATA || path.join(root, 'data');
  return {
    root,
    data,
    home: options.home || os.homedir(),
    platform: options.platform || process.env.CLAWAD_PLATFORM || process.platform,
    dryRun: options.dryRun ?? schedulerDryRunDefault(data),
    interval: intervalMinutes(options.interval || process.env.CLAWAD_SYNC_INTERVAL_MINUTES),
    server: options.server || configuredServerOrigin(),
    node: options.node || process.execPath,
    sync: path.join(root, 'client', 'sync.js'),
    launcher: path.join(root, 'client', 'scheduled-sync.js'),
    meta: path.join(data, 'sync-schedule.json'),
  };
}

function macPlist(ctx) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${MAC_LABEL}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(ctx.node)}</string><string>${xmlEscape(ctx.launcher)}</string><string>${xmlEscape(ctx.data)}</string></array>\n<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>${ctx.interval * 60}</integer>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
}

function linuxUnits(ctx) {
  return {
    service: `[Unit]\nDescription=Clawad background sync\n\n[Service]\nType=oneshot\nExecStart=${unitQuote(ctx.node)} ${unitQuote(ctx.launcher)} ${unitQuote(ctx.data)}\n`,
    timer: `[Unit]\nDescription=Run Clawad sync periodically\n\n[Timer]\nOnStartupSec=30s\nOnUnitActiveSec=${ctx.interval}min\nUnit=clawad-sync.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

// node.exe는 콘솔 프로그램이라, 예약 작업이 직접 실행하면 주기마다 검은 창이 깜빡인다.
// 창 없는 호스트를 앞에 세워 이를 막는다. 작업 설정의 Hidden은 작업 목록에서만 숨기고
// 콘솔 창은 그대로 뜨므로 해결책이 아니다(실측 확인).
//
// conhost --headless는 Windows 내장이라 추가 파일이 없지만 문서화되지 않은 플래그다.
// wscript 셤은 오래된 Windows까지 동작하지만 VBScript는 최신 Windows에서 단계적 폐지 중이다.
// 어느 쪽도 모든 버전을 보장하지 못하므로 설치 시점에 실제로 실행해보고 되는 것을 고른다.
function probeWindowsHiddenHost(ctx, spawn = spawnSync) {
  const ok = (command, args) => {
    try {
      const result = spawn(command, args, { windowsHide: true, timeout: 10000, stdio: 'ignore' });
      return Boolean(result) && !result.error && result.status === 0;
    } catch {
      return false;
    }
  };
  if (ok('conhost.exe', ['--headless', ctx.node, '-e', 'process.exit(0)'])) return 'conhost';
  if (ok('wscript.exe', ['/?'])) return 'wscript';
  return null;
}

/** wscript가 읽는 셤. Run의 세 번째 인자 0이 창을 숨긴다. */
function windowsShimSource(ctx) {
  const quoted = (value) => `""${String(value).replace(/"/g, '')}""`;
  const command = `${quoted(ctx.node)} ${quoted(ctx.launcher)} ${quoted(ctx.data)}`;
  return `CreateObject("WScript.Shell").Run "${command}", 0, False\r\n`;
}

function windowsUsername() {
  return process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : os.userInfo().username;
}

/** 작업이 실행할 실행 파일과 인자. XML은 둘을 따로 담는다(/TR의 한 줄 문자열과 다르다). */
function windowsAction(ctx) {
  const quoted = `"${ctx.launcher}" "${ctx.data}"`;
  if (ctx.hiddenHost === 'conhost') {
    return { command: 'conhost.exe', args: `--headless "${ctx.node}" ${quoted}` };
  }
  if (ctx.hiddenHost === 'wscript' && ctx.shim) {
    return { command: 'wscript.exe', args: `//nologo "${ctx.shim}"` };
  }
  return { command: ctx.node, args: quoted };
}

/**
 * 작업 XML (CLAW-205).
 *
 * schtasks의 명령행 인자로는 전원 조건을 설정할 수 없어, /SC MINUTE로 만든 작업은
 * `No Start On Batteries`가 기본값이 된다 — 노트북이 배터리로 돌면 sync가 아예 실행되지
 * 않는다. XML로 넘기면 그 조건을 끌 수 있고, 로그온 트리거도 같은 작업에 담을 수 있다.
 * /SC ONLOGON은 비관리자 권한에서 거부되지만 XML의 LogonTrigger는 등록된다(실측 확인).
 *
 * StartBoundary는 과거 시각으로 둔다. 반복 트리거는 이 시각을 기준으로만 주기를 세고,
 * StartWhenAvailable이 잠자기로 놓친 실행을 깨어난 뒤 따라잡는다.
 *
 * 맨 앞의 BOM은 필수다. schtasks는 BOM이 붙은 UTF-16LE만 받고, 없으면 "루트 요소가
 * 하나입니다"로 거부한다(실측). 파일로 쓸 때 'utf16le'는 BOM을 넣지 않으므로 여기서 붙인다.
 */
function windowsTaskXml(ctx) {
  const user = xmlEscape(windowsUsername());
  const action = windowsAction(ctx);
  return `﻿<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>클로애드 광고 동기화 (${xmlEscape(ctx.interval)}분 주기·로그온)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT${xmlEscape(ctx.interval)}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(action.command)}</Command>
      <Arguments>${xmlEscape(action.args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// 설치 실패 롤백에서 "이번 설치가 만든 것"과 "원래 있던 것"을 구분하기 위한 등록 존재 검사.
// status()와 달리 메타 파일에 의존하지 않는다 — 메타가 없거나 손상돼도 실 등록은 보존해야 한다.
function registrationExists(ctx) {
  if (ctx.platform === 'win32') {
    return run('schtasks.exe', ['/Query', '/TN', WINDOWS_INTERVAL_TASK], { ...ctx, allowFailure: true }).status === 0;
  }
  if (ctx.platform === 'darwin') {
    return fs.existsSync(path.join(ctx.home, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`));
  }
  if (ctx.platform === 'linux') {
    return fs.existsSync(path.join(ctx.home, '.config', 'systemd', 'user', LINUX_TIMER));
  }
  return false;
}

function install(options = {}) {
  const ctx = context(options);
  ctx.server = serverOrigin(ctx.server);
  ctx.warnings = [];
  fs.mkdirSync(ctx.data, { recursive: true });
  // 실패 롤백이 이번 설치 이전부터 있던 정상 등록까지 지우면 자동 sync가 통째로 사라진다 (CLAW-196).
  const hadExisting = !ctx.dryRun && registrationExists(ctx);

  try {
    if (ctx.platform === 'win32') {
      // 주기 실행마다 콘솔 창이 깜빡이지 않도록 창 없는 호스트를 고른다.
      ctx.hiddenHost = probeWindowsHiddenHost(ctx);
      if (ctx.hiddenHost === 'wscript') {
        ctx.shim = path.join(ctx.data, 'sync-hidden.vbs');
        if (!ctx.dryRun) fs.writeFileSync(ctx.shim, windowsShimSource(ctx));
      } else if (!ctx.hiddenHost) {
        ctx.warnings.push(
          '이 Windows에서는 창 없이 실행할 방법을 찾지 못해, sync가 실행될 때마다 콘솔 창이 잠깐 나타납니다. ' +
            '동기화와 광고 표시에는 영향이 없습니다.',
        );
      }
      // 트리거 두 개를 한 작업에 담으므로 등록도 한 번이다 (CLAW-205).
      // windowsTaskXml이 BOM까지 붙여 준다 — schtasks가 BOM 없는 UTF-16을 거부한다.
      const xmlFile = path.join(ctx.data, 'sync-task.xml');
      if (!ctx.dryRun) fs.writeFileSync(xmlFile, windowsTaskXml(ctx), 'utf16le');
      try {
        run('schtasks.exe', ['/Create', '/TN', WINDOWS_INTERVAL_TASK, '/XML', xmlFile, '/F'], ctx);
      } finally {
        // 사용자명이 담긴 파일을 남겨둘 이유가 없다. 등록 성공·실패와 무관하게 지운다.
        if (!ctx.dryRun) { try { fs.unlinkSync(xmlFile); } catch {} }
      }
      // 0.1.21 이하가 만든 로그온 전용 작업. 남겨두면 같은 sync가 두 번 돈다.
      run('schtasks.exe', ['/Delete', '/TN', WINDOWS_LOGON_TASK, '/F'], { ...ctx, allowFailure: true });
    } else if (ctx.platform === 'darwin') {
      const dir = ctx.dryRun ? path.join(ctx.data, 'scheduler-preview') : path.join(ctx.home, 'Library', 'LaunchAgents');
      const file = path.join(dir, `${MAC_LABEL}.plist`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, macPlist(ctx));
      const domain = `gui/${userId()}`;
      run('launchctl', ['bootout', domain, file], { ...ctx, allowFailure: true });
      run('launchctl', ['bootstrap', domain, file], ctx);
    } else if (ctx.platform === 'linux') {
      const dir = ctx.dryRun ? path.join(ctx.data, 'scheduler-preview') : path.join(ctx.home, '.config', 'systemd', 'user');
      const units = linuxUnits(ctx);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'clawad-sync.service'), units.service);
      fs.writeFileSync(path.join(dir, LINUX_TIMER), units.timer);
      run('systemctl', ['--user', 'daemon-reload'], ctx);
      run('systemctl', ['--user', 'enable', '--now', LINUX_TIMER], ctx);
    } else {
      throw new Error(`지원하지 않는 운영체제입니다: ${ctx.platform}`);
    }
  } catch (error) {
    // 이번 설치 전에 등록이 없었을 때만 부분 설치 잔재를 정리한다. 기존 등록이 있었다면
    // 그대로 두는 쪽이 낫다 — 삭제하면 복구 경로(이전 버전 재설치)마저 실패했을 때 영구 중단된다.
    if (!hadExisting) {
      try { uninstall(options); } catch {}
    }
    throw error;
  }

  writeJsonAtomic(ctx.meta, {
    platform: ctx.platform,
    intervalMinutes: ctx.interval,
    paused: false,
    server: ctx.server,
  });
  return ctx;
}

function setPaused(paused, options = {}) {
  const ctx = context(options);
  if (!fs.existsSync(ctx.meta)) return false;
  if (ctx.platform === 'win32') {
    run('schtasks.exe', ['/Change', '/TN', WINDOWS_INTERVAL_TASK, paused ? '/DISABLE' : '/ENABLE'], ctx);
    // 로그온 작업은 등록 자체가 없을 수 있다. 없다고 해서 일시중지·재개를 실패시키지 않는다.
    run('schtasks.exe', ['/Change', '/TN', WINDOWS_LOGON_TASK, paused ? '/DISABLE' : '/ENABLE'], { ...ctx, allowFailure: true });
    if (!paused) run('schtasks.exe', ['/Run', '/TN', WINDOWS_INTERVAL_TASK], { ...ctx, allowFailure: true });
  } else if (ctx.platform === 'darwin') {
    const dir = ctx.dryRun ? path.join(ctx.data, 'scheduler-preview') : path.join(ctx.home, 'Library', 'LaunchAgents');
    const file = path.join(dir, `${MAC_LABEL}.plist`);
    const domain = `gui/${userId()}`;
    run('launchctl', ['bootout', domain, file], { ...ctx, allowFailure: true });
    if (!paused) run('launchctl', ['bootstrap', domain, file], ctx);
  } else if (ctx.platform === 'linux') {
    run('systemctl', ['--user', paused ? 'disable' : 'enable', '--now', LINUX_TIMER], ctx);
  }
  const meta = JSON.parse(fs.readFileSync(ctx.meta, 'utf8').replace(/^\uFEFF/, ''));
  writeJsonAtomic(ctx.meta, { ...meta, paused });
  return true;
}

function uninstall(options = {}) {
  const ctx = context(options);
  if (ctx.platform === 'win32') {
    // WINDOWS_TASKS에는 0.1.21 이하가 만든 로그온 전용 작업도 들어 있다 — 함께 지운다.
    for (const task of WINDOWS_TASKS) run('schtasks.exe', ['/Delete', '/TN', task, '/F'], { ...ctx, allowFailure: true });
    // 설치 시 만든 창 숨김 셤도 제거한다 (규칙 §7 원상복구).
    try { fs.unlinkSync(path.join(ctx.data, 'sync-hidden.vbs')); } catch {}
    // 등록 중 죽어 남았을 수 있는 작업 XML. 사용자명이 담기므로 남기지 않는다.
    try { fs.unlinkSync(path.join(ctx.data, 'sync-task.xml')); } catch {}
  } else if (ctx.platform === 'darwin') {
    const dir = ctx.dryRun ? path.join(ctx.data, 'scheduler-preview') : path.join(ctx.home, 'Library', 'LaunchAgents');
    const file = path.join(dir, `${MAC_LABEL}.plist`);
    run('launchctl', ['bootout', `gui/${userId()}`, file], { ...ctx, allowFailure: true });
    try { fs.unlinkSync(file); } catch {}
  } else if (ctx.platform === 'linux') {
    const dir = ctx.dryRun ? path.join(ctx.data, 'scheduler-preview') : path.join(ctx.home, '.config', 'systemd', 'user');
    run('systemctl', ['--user', 'disable', '--now', LINUX_TIMER], { ...ctx, allowFailure: true });
    for (const name of ['clawad-sync.service', LINUX_TIMER]) {
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
    }
    run('systemctl', ['--user', 'daemon-reload'], { ...ctx, allowFailure: true });
  }
  try { fs.unlinkSync(ctx.meta); } catch {}
}

function status(options = {}) {
  const ctx = context(options);
  try {
    const meta = JSON.parse(fs.readFileSync(ctx.meta, 'utf8').replace(/^\uFEFF/, ''));
    let exists = true;
    if (!ctx.dryRun && ctx.platform === 'win32') {
      // 필수 주기 작업만 있으면 등록된 것으로 본다. 선택 작업 부재를 미등록으로 오보고하지 않는다.
      exists = run('schtasks.exe', ['/Query', '/TN', WINDOWS_INTERVAL_TASK], { ...ctx, allowFailure: true }).status === 0;
    } else if (ctx.platform === 'darwin') {
      const dir = ctx.dryRun ? path.join(ctx.data, 'scheduler-preview') : path.join(ctx.home, 'Library', 'LaunchAgents');
      exists = fs.existsSync(path.join(dir, `${MAC_LABEL}.plist`));
    } else if (ctx.platform === 'linux') {
      const dir = ctx.dryRun ? path.join(ctx.data, 'scheduler-preview') : path.join(ctx.home, '.config', 'systemd', 'user');
      exists = fs.existsSync(path.join(dir, LINUX_TIMER));
    }
    if (!exists) return { installed: false, paused: false, intervalMinutes: meta.intervalMinutes, platform: meta.platform };
    return { installed: true, paused: Boolean(meta.paused), intervalMinutes: meta.intervalMinutes, platform: meta.platform };
  } catch {
    return { installed: false, paused: false, intervalMinutes: ctx.interval, platform: ctx.platform };
  }
}

module.exports = {
  context,
  install,
  intervalMinutes,
  linuxUnits,
  macPlist,
  probeWindowsHiddenHost,
  serverOrigin,
  setPaused,
  status,
  uninstall,
  windowsShimSource,
  windowsAction,
  windowsTaskXml,
};
