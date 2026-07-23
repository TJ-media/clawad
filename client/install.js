#!/usr/bin/env node
// clawad — 설치·제거·일시중지 (CLAW-24 §설치 UX, rules §7).
//
//   node client/install.js install    설치 전 변경 내용을 고지하고 기존 statusLine을 백업한 뒤 설정한다
//   node client/install.js uninstall  백업에서 원상복구한다
//   node client/install.js pause      광고 표시를 일시중지한다
//   node client/install.js resume     일시중지를 해제한다
//   node client/install.js status     현재 상태를 출력한다
//
// 사용자 설정 파일을 건드리므로, 항상 백업을 먼저 만들고 무엇을 바꾸는지 출력한다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const syncScheduler = require('./sync-scheduler');
const { requestInitialSync } = require('./initial-sync');
const { defaultDataDir, distributionConfig, userCommand } = require('./distribution-config');
const cliBinary = require('./cli-binary');
const { loadPolicy } = require('../policy/policy');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const PAUSE_FILE = path.join(DATA, 'paused');
const SETTINGS_FILE = process.env.CLAWAD_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_FILE = path.join(DATA, 'statusline-backup.json');
const COMPOSITION_FILE = path.join(DATA, 'statusline-composition.json');
const AUTH_FILE = process.env.CLAWAD_AUTH || path.join(DATA, 'auth.json');

function quoteArg(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
const STATUSLINE_COMMAND = `${quoteArg(process.execPath)} ${quoteArg(path.join(ROOT, 'client', 'statusline-wrapper.js'))}`;
const WORK_ACTIVITY_COMMAND = `${quoteArg(process.execPath)} ${quoteArg(path.join(ROOT, 'client', 'work-activity.js'))}`;
const ACTIVITY_HOOKS = [
  ['UserPromptSubmit', 'start'],
  ['Stop', 'stop'],
  ['StopFailure', 'stop'],
  ['SessionEnd', 'stop'],
];

// Claude Code의 statusLine.refreshInterval 단위는 **초**다("re-runs your command every N seconds,
// The minimum is 1"). 정책값은 밀리초이므로 반드시 변환해서 넣는다 — 그대로 넣으면 1000초(약 16.7분)가 되어
// 유휴 상태에서 광고·안내문이 사실상 갱신되지 않는다.
function refreshIntervalSeconds() {
  return Math.max(1, Math.round(loadPolicy().statusLine.refreshIntervalMs / 1000));
}

function statusLineConfig() {
  return {
    type: 'command',
    command: STATUSLINE_COMMAND,
    refreshInterval: refreshIntervalSeconds(),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function isClawadStatusLine(statusLine) {
  return Boolean(statusLine && typeof statusLine.command === 'string' &&
    (statusLine.command.includes('statusline-wrapper.js') || statusLine.command.includes('client/statusline.js') || statusLine.command.includes('client\\statusline.js')));
}

function isWrapperStatusLine(statusLine) {
  return Boolean(statusLine && typeof statusLine.command === 'string' && statusLine.command.includes('statusline-wrapper.js'));
}

function diagnoseInstallation() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error('설치 진단 실패(NODE_VERSION): Node.js 24 이상이 필요합니다.');
  for (const file of [process.execPath, path.join(ROOT, 'client', 'statusline-wrapper.js'), path.join(ROOT, 'client', 'work-activity.js')]) {
    try { fs.accessSync(file, fs.constants.R_OK); } catch { throw new Error('설치 진단 실패(FILE_ACCESS): 실행 파일을 읽을 수 없습니다.'); }
  }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.accessSync(path.dirname(SETTINGS_FILE), fs.constants.W_OK);
  } catch { throw new Error('설치 진단 실패(SETTINGS_WRITE): Claude 설정 디렉터리에 쓸 수 없습니다.'); }
  if (process.env.CLAWAD_WORKSPACE_TRUSTED === '0') {
    throw new Error('설치 진단 실패(WORKSPACE_TRUST): Claude Code에서 이 작업공간을 신뢰한 뒤 다시 실행하세요.');
  }
}

function healthCheck() {
  const timeout = loadPolicy().statusLine.healthCheckTimeoutMs;
  const result = spawnSync(process.execPath, [path.join(ROOT, 'client', 'statusline-wrapper.js')], {
    input: '{}', encoding: 'utf8', shell: false, windowsHide: true, timeout,
    env: { ...process.env, CLAWAD_DATA: DATA },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') throw new Error('설치 확인 실패(HEALTH_TIMEOUT): status line 응답이 지연됩니다.');
  if (result.status !== 0) throw new Error('설치 확인 실패(HEALTH_EXEC): status line을 실행할 수 없습니다.');
  if (!result.stdout.trim()) throw new Error('설치 확인 실패(HEALTH_EMPTY): status line 출력이 없습니다.');
  if (result.stdout.trim().split(/\r?\n/).length !== 1) throw new Error('설치 확인 실패(HEALTH_OUTPUT): status line 출력 형식이 올바르지 않습니다.');
}

function installActivityHooks(settings) {
  removeActivityHooks(settings);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [event, action] of ACTIVITY_HOOKS) {
    const command = `${WORK_ACTIVITY_COMMAND} ${action}`;
    const hooks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    if (!hooks.some((entry) => Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook && hook.command === command))) {
      hooks.push({ hooks: [{ type: 'command', command }] });
    }
    settings.hooks[event] = hooks;
  }
}

function removeActivityHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter((entry) => {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks.filter((hook) => !String(hook && hook.command).includes('work-activity.js')) : [];
      if (hooks.length && hooks.length !== entry.hooks.length) entry.hooks = hooks;
      return hooks.length || !Array.isArray(entry.hooks);
    });
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

function install() {
  diagnoseInstallation();
  const settings = readJson(SETTINGS_FILE, {});
  const previousHooks = settings.hooks === undefined ? undefined : JSON.parse(JSON.stringify(settings.hooks));
  const existing = settings.statusLine;
  const addedStatusLine = !isClawadStatusLine(existing);
  const upgradedLegacyStatusLine = !addedStatusLine && !isWrapperStatusLine(existing);
  const changedPackageRoot = !addedStatusLine && isWrapperStatusLine(existing) && existing.command !== STATUSLINE_COMMAND;

  if (!addedStatusLine) {
    console.log('statusLine은 이미 설치되어 있습니다. 자동 sync 설정을 확인합니다.');
  } else {
    console.log('클로애드를 설치하면 다음이 변경됩니다:');
    console.log('  파일: Claude 사용자 settings.json');
    console.log('  설정: 검증된 Node 절대경로로 statusLine wrapper 등록');
    if (existing) {
      console.log('  기존 statusLine 설정을 클로애드 로컬 데이터에 백업합니다.');
      console.log('  기존 출력과 클로애드 광고를 한 줄로 조합하며, 일시중지 시 기존 출력만 유지합니다.');
    } else {
      console.log('  기존 statusLine 설정은 없습니다. 제거 시 statusLine 항목을 삭제합니다.');
    }
    console.log('  사용자 범위 백그라운드 작업으로 로그인 후와 설정 주기마다 sync를 실행합니다.');
    console.log('  상태줄에는 [광고] 표기가 붙은 광고 한 줄과 예상 적립 포인트가 표시됩니다.');
    console.log('  프롬프트·코드·파일 경로·터미널 명령어는 수집하지 않습니다.');
    // 전역 명령 설치는 선택 단계지만 시스템 변경이므로 미리 고지한다(rules §7).
    if (distributionConfig().packageUrl) {
      console.log('  전역 clawad 명령을 설치해 이후 `clawad update`처럼 짧게 실행할 수 있게 합니다.');
      console.log('  실패해도 설치는 계속되며, 제거 시 전역 명령도 함께 제거합니다.');
    }
    console.log('');

    // 원상복구를 위해 기존 값을 그대로 보관한다. 없었으면 없었다는 사실을 기록한다.
    writeJson(BACKUP_FILE, { hadStatusLine: existing !== undefined, statusLine: existing ?? null });
    writeJson(COMPOSITION_FILE, { version: 1, originalCommand: existing && existing.type === 'command' ? existing.command : null });

    settings.statusLine = statusLineConfig();
    writeJson(SETTINGS_FILE, settings);
  }
  if (!addedStatusLine && settings.statusLine.refreshInterval !== statusLineConfig().refreshInterval) {
    settings.statusLine = { ...settings.statusLine, refreshInterval: statusLineConfig().refreshInterval };
    writeJson(SETTINGS_FILE, settings);
  }
  if (upgradedLegacyStatusLine) {
    const backup = readJson(BACKUP_FILE, { hadStatusLine: false, statusLine: null });
    writeJson(COMPOSITION_FILE, { version: 1, originalCommand: backup.hadStatusLine && backup.statusLine ? backup.statusLine.command : null });
    settings.statusLine = statusLineConfig();
  }
  if (changedPackageRoot) settings.statusLine = statusLineConfig();
  installActivityHooks(settings);
  writeJson(SETTINGS_FILE, settings);

  let scheduled;
  try {
    healthCheck();
    scheduled = syncScheduler.install({ root: ROOT, data: DATA });
  } catch (error) {
    if (addedStatusLine || upgradedLegacyStatusLine || changedPackageRoot) {
      const rollback = readJson(SETTINGS_FILE, {});
      if (existing === undefined) delete rollback.statusLine;
      else rollback.statusLine = existing;
      writeJson(SETTINGS_FILE, rollback);
      if (addedStatusLine) try { fs.unlinkSync(BACKUP_FILE); } catch {}
      if (addedStatusLine || upgradedLegacyStatusLine) try { fs.unlinkSync(COMPOSITION_FILE); } catch {}
    }
    const rollback = readJson(SETTINGS_FILE, {});
    if (previousHooks === undefined) delete rollback.hooks;
    else rollback.hooks = previousHooks;
    writeJson(SETTINGS_FILE, rollback);
    throw error;
  }
  console.log(`자동 sync 등록 완료 (${scheduled.interval}분 주기).`);
  for (const warning of scheduled.warnings || []) console.log(warning);
  if (fs.existsSync(AUTH_FILE)) {
    try {
      requestInitialSync({ data: DATA });
      console.log('기존 로그인 정보를 확인해 최초 광고 준비 동기화를 시작했습니다.');
    } catch {}
  }
  // 선택 단계다. 실패해도 설치는 이미 끝났으므로 경고만 남기고 안내는 기존 형태로 되돌린다.
  const binary = cliBinary.install(DATA);
  if (binary.installed) console.log('전역 clawad 명령을 설치했습니다. 이후 `clawad update`처럼 짧게 실행할 수 있습니다.');
  else if (!binary.skipped) console.log(`전역 clawad 명령은 설치하지 못했습니다(선택 단계). 기존 방식으로 계속 사용할 수 있습니다. 사유: ${binary.reason}`);
  console.log(`설치 완료. 제거하려면: ${userCommand('uninstall')}`);
}

function uninstall() {
  const settings = readJson(SETTINGS_FILE, {});
  const hadScheduler = syncScheduler.status({ root: ROOT, data: DATA }).installed;
  syncScheduler.uninstall({ root: ROOT, data: DATA });
  if (hadScheduler) console.log('클로애드 자동 sync 작업을 제거했습니다.');

  // 설치 때 전역 명령을 넣었으면 되돌린다(rules §7 원상복구).
  const binary = cliBinary.remove(DATA);
  if (binary.removed) console.log('전역 clawad 명령을 제거했습니다.');
  else if (!binary.skipped) console.log(`전역 clawad 명령을 제거하지 못했습니다. 사유: ${binary.reason}`);

  if (!isClawadStatusLine(settings.statusLine)) {
    console.log('클로애드 statusLine 설정이 없습니다. 다른 설정은 건드리지 않습니다.');
    return;
  }

  removeActivityHooks(settings);

  const backup = readJson(BACKUP_FILE, null);
  if (backup && backup.hadStatusLine && backup.statusLine) {
    settings.statusLine = backup.statusLine;
    console.log('기존 statusLine 설정을 원상복구했습니다.');
  } else {
    delete settings.statusLine;
    console.log('statusLine 설정을 제거했습니다 (설치 전에도 없었음).');
  }
  writeJson(SETTINGS_FILE, settings);

  try {
    fs.unlinkSync(BACKUP_FILE);
  } catch {}
  try { fs.unlinkSync(COMPOSITION_FILE); } catch {}
  try { fs.unlinkSync(path.join(DATA, 'statusline-original-failure.json')); } catch {}
  console.log('제거 완료. 클로애드 로컬 데이터는 보존됩니다.');
}

function pause() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(PAUSE_FILE, new Date().toISOString());
  syncScheduler.setPaused(true, { root: ROOT, data: DATA });
  console.log(`광고 표시와 자동 sync를 일시중지했습니다. 해제: ${userCommand('resume')}`);
}

function resume() {
  if (!fs.existsSync(PAUSE_FILE)) {
    console.log('일시중지 상태가 아닙니다.');
    return;
  }
  try { fs.unlinkSync(PAUSE_FILE); } catch {}
  try {
    syncScheduler.setPaused(false, { root: ROOT, data: DATA });
  } catch (error) {
    fs.writeFileSync(PAUSE_FILE, new Date().toISOString());
    throw error;
  }
  if (fs.existsSync(AUTH_FILE)) requestInitialSync({ data: DATA });
  console.log('광고 표시와 자동 sync를 재개했습니다.');
}

function status() {
  const settings = readJson(SETTINGS_FILE, {});
  const scheduled = syncScheduler.status({ root: ROOT, data: DATA });
  const syncState = readJson(path.join(DATA, 'sync-state.json'), {}) || {};
  const nextBase = syncState.lastRunAt || syncState.lastSuccessAt;
  const nextRun = nextBase && scheduled.installed && !scheduled.paused
    ? new Date(Date.parse(nextBase) + scheduled.intervalMinutes * 60000).toISOString()
    : null;
  console.log(`설치됨   : ${isClawadStatusLine(settings.statusLine) ? '예' : '아니오'}`);
  console.log(`일시중지 : ${fs.existsSync(PAUSE_FILE) ? '예' : '아니오'}`);
  const composition = readJson(COMPOSITION_FILE, {});
  if (composition.originalCommand) {
    const failure = readJson(path.join(DATA, 'statusline-original-failure.json'), null);
    console.log(`기존 statusLine: ${failure ? `실행 실패 (${failure.code}: ${failure.detail}, ${failure.at})` : '조합 중 (실패 기록 없음)'}`);
  }
  console.log(`자동 sync: ${scheduled.installed ? scheduled.paused ? '중지됨' : '등록됨' : '미등록'}`);
  console.log(`최근 성공: ${syncState.lastSuccessAt || '없음'}`);
  console.log(`다음 예정: ${nextRun || '스케줄러가 결정'}`);
  if (syncState.lastError) console.log(`최근 오류: ${syncState.lastError.code} — ${syncState.lastError.message}`);
  console.log('설정 파일: Claude 사용자 settings.json');
}

const COMMANDS = { install, uninstall, pause, resume, status };
const command = process.argv[2];

if (!command || !COMMANDS[command]) {
  console.error('사용법: node client/install.js <install|uninstall|pause|resume|status>');
  process.exit(1);
}
try {
  COMMANDS[command]();
} catch (error) {
  console.error(error && error.message ? error.message : '설치 관리 작업에 실패했습니다.');
  process.exit(1);
}
