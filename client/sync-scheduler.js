'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeJsonAtomic } = require('./sync-runtime');
const { serverOrigin: configuredServerOrigin } = require('./distribution-config');

// 주기 작업이 동기화의 필수 경로다. 로그온 작업은 첫 동기화를 앞당기는 부가 작업일 뿐이고,
// 관리형 Windows에서는 일반 권한으로 등록이 거부되므로 실패해도 설치를 중단하지 않는다.
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
  if (result.error || (result.status !== 0 && !options.allowFailure)) {
    const message = options.message || '자동 sync 작업을 설정하지 못했습니다.';
    const detail = failureDetail(result);
    throw new Error(detail ? `${message} (${command}: ${detail})` : message);
  }
  return result;
}

function context(options = {}) {
  const root = options.root || path.join(__dirname, '..');
  const data = options.data || process.env.CLAWAD_DATA || path.join(root, 'data');
  return {
    root,
    data,
    home: options.home || os.homedir(),
    platform: options.platform || process.env.CLAWAD_PLATFORM || process.platform,
    dryRun: options.dryRun ?? process.env.CLAWAD_SCHEDULER_DRY_RUN === '1',
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

function windowsTaskDefinitions(ctx) {
  const taskCommand = `"${ctx.node}" "${ctx.launcher}" "${ctx.data}"`;
  const username = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : os.userInfo().username;
  return [
    {
      task: WINDOWS_INTERVAL_TASK,
      optional: false,
      args: ['/Create', '/TN', WINDOWS_INTERVAL_TASK, '/TR', taskCommand, '/SC', 'MINUTE', '/MO', String(ctx.interval), '/RU', username, '/IT', '/RL', 'LIMITED', '/F'],
    },
    {
      task: WINDOWS_LOGON_TASK,
      optional: true,
      args: ['/Create', '/TN', WINDOWS_LOGON_TASK, '/TR', taskCommand, '/SC', 'ONLOGON', '/RU', username, '/IT', '/RL', 'LIMITED', '/F'],
    },
  ];
}

function install(options = {}) {
  const ctx = context(options);
  ctx.server = serverOrigin(ctx.server);
  ctx.warnings = [];
  fs.mkdirSync(ctx.data, { recursive: true });

  try {
    if (ctx.platform === 'win32') {
      for (const definition of windowsTaskDefinitions(ctx)) {
        if (!definition.optional) {
          run('schtasks.exe', definition.args, ctx);
          continue;
        }
        // 선택 작업 실패로 이미 등록한 필수 작업까지 되돌리면 자동 sync가 통째로 사라진다.
        const result = run('schtasks.exe', definition.args, { ...ctx, allowFailure: true });
        if (result.status !== 0) {
          const detail = failureDetail(result);
          ctx.warnings.push(
            `로그온 시 즉시 sync 작업(${definition.task})은 등록하지 못했습니다. ` +
              `${ctx.interval}분 주기 sync는 정상 등록됐으므로 광고 표시에는 영향이 없습니다. ` +
              '관리자 권한으로 다시 설치하면 함께 등록됩니다.' +
              (detail ? `\n  원인: ${detail}` : ''),
          );
        }
      }
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
    try { uninstall(options); } catch {}
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
    for (const task of WINDOWS_TASKS) run('schtasks.exe', ['/Delete', '/TN', task, '/F'], { ...ctx, allowFailure: true });
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

module.exports = { install, intervalMinutes, linuxUnits, macPlist, serverOrigin, setPaused, status, uninstall, windowsTaskDefinitions };
