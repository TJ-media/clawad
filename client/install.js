#!/usr/bin/env node
// clawad — 설치·제거·일시중지 (CLAW-24 §설치 UX, rules §7).
//
//   node client/install.js install    설치 전 변경 내용을 고지하고 활동 감지 훅·자동 sync를 설정한다
//   node client/install.js uninstall  훅·스케줄러·오버레이를 제거하고 원상복구한다
//   node client/install.js pause      광고 표시를 일시중지한다
//   node client/install.js resume     일시중지를 해제한다
//   node client/install.js status     현재 상태를 출력한다
//
// 광고 표시는 오버레이 앱이 전담한다 — 클로애드는 Claude Code의 statusLine 슬롯을 점유하지
// 않는다(CLAW-134). 슬롯이 하나뿐이라 우리가 잡고 있으면 오버레이가 구독 쿼터를 읽을 수 없다.
// 사용자 설정 파일을 건드리므로, 무엇을 바꾸는지 항상 출력한다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const syncScheduler = require('./sync-scheduler');
const { requestInitialSync } = require('./initial-sync');
const { defaultDataDir, distributionConfig, overlayManifestUrl, userCommand } = require('./distribution-config');
const cliBinary = require('./cli-binary');
const { loadPolicy } = require('../policy/policy');
const { dayKey } = require('./ledger-summary');
// 설치·제거·롤백 도중 프로세스가 죽어도 사용자 settings.json이 잘린 채 남지 않게 한다 (CLAW-183).
const { writeJsonAtomic } = require('./sync-runtime');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const PAUSE_FILE = path.join(DATA, 'paused');
const SETTINGS_FILE = process.env.CLAWAD_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
// 0.1.11까지 statusLine 슬롯을 점유하던 시절의 백업·조합 상태. 지금은 슬롯을 쓰지 않으므로
// 설치 시 백업을 되돌리고 두 파일을 소비한다(아래 releaseStatusLineSlot).
const BACKUP_FILE = path.join(DATA, 'statusline-backup.json');
const COMPOSITION_FILE = path.join(DATA, 'statusline-composition.json');
const ORIGINAL_FAILURE_FILE = path.join(DATA, 'statusline-original-failure.json');
const AUTH_FILE = process.env.CLAWAD_AUTH || path.join(DATA, 'auth.json');

function quoteArg(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
const WORK_ACTIVITY_COMMAND = `${quoteArg(process.execPath)} ${quoteArg(path.join(ROOT, 'client', 'work-activity.js'))}`;
const ACTIVITY_HOOKS = [
  ['UserPromptSubmit', 'start'],
  ['Stop', 'stop'],
  ['StopFailure', 'stop'],
  ['SessionEnd', 'stop'],
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

// 0.1.11까지 우리가 등록하던 statusLine. 슬롯을 비우는 마이그레이션에서만 쓴다 — 새로 등록하지 않는다.
function isClawadStatusLine(statusLine) {
  return Boolean(statusLine && typeof statusLine.command === 'string' &&
    (statusLine.command.includes('statusline-wrapper.js') || statusLine.command.includes('client/statusline.js') || statusLine.command.includes('client\\statusline.js')));
}

function diagnoseInstallation() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error('설치 진단 실패(NODE_VERSION): Node.js 24 이상이 필요합니다.');
  for (const file of [process.execPath, path.join(ROOT, 'client', 'work-activity.js'), path.join(ROOT, 'client', 'overlay-events.js')]) {
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

// 설정 파일에 등록하는 것은 활동 감지 훅뿐이므로(광고 표시는 오버레이 담당) 그 훅이 실제로
// 실행되는지만 확인한다. session_id 없는 입력은 아무 상태도 만들지 않고 0으로 끝난다 —
// 확인이 사용자 활동 기록을 오염시키지 않는다.
function healthCheck() {
  const timeout = loadPolicy().client.hookHealthCheckTimeoutMs;
  const result = spawnSync(process.execPath, [path.join(ROOT, 'client', 'work-activity.js'), 'stop'], {
    input: '{}', encoding: 'utf8', shell: false, windowsHide: true, timeout,
    env: { ...process.env, CLAWAD_DATA: DATA },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') throw new Error('설치 확인 실패(HEALTH_TIMEOUT): 활동 감지 훅 응답이 지연됩니다.');
  if (result.status !== 0) throw new Error('설치 확인 실패(HEALTH_EXEC): 활동 감지 훅을 실행할 수 없습니다.');
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

// 설치 여부의 기준. statusLine 슬롯을 쓰지 않게 된 뒤로 우리가 settings.json에 남기는 것은
// 활동 감지 훅뿐이다 (CLAW-134).
function hasActivityHooks(settings) {
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object') return false;
  return Object.values(settings.hooks).some((entries) => Array.isArray(entries) && entries.some((entry) =>
    Array.isArray(entry && entry.hooks) && entry.hooks.some((hook) => String(hook && hook.command).includes('work-activity.js'))));
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

// 0.1.11 이하에서 우리가 잡고 있던 statusLine 슬롯을 비운다 (CLAW-134, rules §7 원상복구).
// 설치 전 값이 있었으면 그대로 되돌리고, 없었으면 항목을 지운다. 백업 파일은 여기서 지우지
// 않는다 — 설치가 끝까지 성공한 뒤에 소비한다(consumeStatusLineBackup). 중간에 실패해 롤백하면
// 백업이 남아 있어야 다음 설치가 원래 값을 되돌릴 수 있다.
function releaseStatusLineSlot(settings) {
  if (!isClawadStatusLine(settings.statusLine)) return null;
  const backup = readJson(BACKUP_FILE, null);
  const restored = backup && backup.hadStatusLine && backup.statusLine ? backup.statusLine : null;
  if (restored) settings.statusLine = restored;
  else delete settings.statusLine;
  return { restored: Boolean(restored) };
}

// 슬롯을 놓아준 뒤 남는 조합·백업 상태. 다시 점유하는 코드가 없으므로 보관할 이유가 없다.
function consumeStatusLineBackup() {
  for (const file of [BACKUP_FILE, COMPOSITION_FILE, ORIGINAL_FAILURE_FILE]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

async function install() {
  diagnoseInstallation();
  const settings = readJson(SETTINGS_FILE, {});
  const previousHooks = settings.hooks === undefined ? undefined : JSON.parse(JSON.stringify(settings.hooks));
  const previousStatusLine = settings.statusLine;
  const hadActivityHooks = hasActivityHooks(settings);

  if (!hadActivityHooks) {
    console.log('클로애드를 설치하면 다음이 변경됩니다:');
    console.log('  파일: Claude 사용자 settings.json');
    console.log('  설정: 광고 표시 구간을 판정할 활동 감지 훅을 등록합니다(세션 식별자만 사용).');
    console.log('  이 CLI는 statusLine 설정을 건드리지 않습니다 — 광고는 상태줄에 표시하지 않습니다.');
    console.log('  사용자 범위 백그라운드 작업으로 로그인 후와 설정 주기마다 sync를 실행합니다.');
    console.log('  프롬프트·코드·파일 경로·터미널 명령어는 서버로 전송하지 않습니다.');
    console.log('  이 클라이언트는 해당 데이터를 읽지 않습니다. 데스크탑 오버레이 앱의 단말 내 처리 항목은 처리방침 제1장 바.에 고지돼 있습니다.');
    // 전역 명령 설치는 선택 단계지만 시스템 변경이므로 미리 고지한다(rules §7).
    if (distributionConfig().packageUrl) {
      console.log('  전역 clawad 명령을 설치해 이후 `clawad update`처럼 짧게 실행할 수 있게 합니다.');
      console.log('  실패해도 설치는 계속되며, 제거 시 전역 명령도 함께 제거합니다.');
    }
    // 오버레이는 별도 프로그램이지만 같은 설치 흐름에서 함께 넣는다(CLAW-133). 규칙 §7이
    // 요구하는 것은 "설치 전 고지"이므로 중간에 묻지 않고 여기서 한 번에 알린다.
    if (overlayManifestUrl()) {
      console.log('  데스크탑 오버레이 앱(Claw-Ad)을 함께 설치합니다 — 약 110MB를 내려받습니다.');
      console.log('  트레이에 상주하며 광고는 [광고] 표기와 함께 마스코트 아래 한 줄로 표시됩니다.');
      console.log('  광고 표시 창구는 이 앱뿐입니다 — 설치하지 않으면 광고도 적립도 발생하지 않습니다.');
      // 오버레이가 statusLine 슬롯을 쓰는 것은 CLI가 아니라 그 앱의 동작이지만, 사용자 입장에서는
      // 같은 설치 한 번으로 일어나는 변경이므로 여기서 함께 고지한다 (CLAW-136, rules §7).
      console.log('  이 앱은 statusLine이 비어 있으면 그 자리에 Claude 구독 사용량 표시를 등록합니다.');
      console.log('  이미 쓰는 statusLine이 있으면 건드리지 않고, 앱 설정에서 끌 수 있으며 제거 시 되돌립니다.');
      console.log('  사용량 값은 화면 표시에만 쓰고 서버로 전송하지 않습니다.');
      console.log('  관리자 권한은 필요하지 않고, 실패해도 설치는 계속됩니다. 제거 시 함께 제거합니다.');
      // 알파는 무서명 배포다(CLAW-95 예외). 설치 위치와 서명 상태를 미리 알린다 — 규칙 §7.
      if (process.platform === 'darwin') {
        console.log('  설치 위치는 사용자 홈의 응용 프로그램 폴더입니다(시스템 영역을 건드리지 않습니다).');
        console.log('  알파 빌드는 Apple 개발자 서명을 받지 않았습니다. 직접 내려받아 열면 macOS가 경고를 띄울 수 있습니다.');
      }
      console.log('  오버레이는 AGPL-3.0 오픈소스입니다: https://github.com/TJ-media/clawad-overlay');
    }
    console.log('');
  } else {
    console.log('활동 감지 훅은 이미 설치되어 있습니다. 자동 sync 설정을 확인합니다.');
  }

  const released = releaseStatusLineSlot(settings);
  installActivityHooks(settings);
  writeJsonAtomic(SETTINGS_FILE, settings);
  if (released) {
    console.log(released.restored
      ? '이전 버전이 점유하던 statusLine을 설치 전 설정으로 원상복구했습니다. 광고는 오버레이 앱에서만 표시됩니다.'
      : 'statusLine 설정에서 클로애드 항목을 제거했습니다(설치 전에도 없었음). 광고는 오버레이 앱에서만 표시됩니다.');
  }

  let scheduled;
  try {
    healthCheck();
    scheduled = syncScheduler.install({ root: ROOT, data: DATA });
  } catch (error) {
    const rollback = readJson(SETTINGS_FILE, {});
    if (previousStatusLine === undefined) delete rollback.statusLine;
    else rollback.statusLine = previousStatusLine;
    if (previousHooks === undefined) delete rollback.hooks;
    else rollback.hooks = previousHooks;
    writeJsonAtomic(SETTINGS_FILE, rollback);
    throw error;
  }
  if (released) consumeStatusLineBackup();
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

  await installOverlayStep();

  console.log(`설치 완료. 제거하려면: ${userCommand('uninstall')}`);
}

// 오버레이 설치. 실패해도 CLI 설치는 성공으로 끝낸다 — 광고 표시가 늦어질 뿐이고,
// 사용자가 나중에 직접 넣을 수 있도록 사유와 대안을 남긴다.
async function installOverlayStep() {
  const manifestUrl = overlayManifestUrl();
  if (!manifestUrl) return;
  const { installOverlay } = require('./overlay-install');
  const result = await installOverlay({ manifestUrl, log: (line) => console.log(line) });
  switch (result.status) {
    case 'installed':
      console.log(`데스크탑 오버레이 앱을 설치했습니다 (v${result.version}).`);
      if (result.sourceUrl) console.log(`  오버레이 소스(${result.license || 'AGPL-3.0-only'}): ${result.sourceUrl}`);
      break;
    case 'skipped':
      if (result.reason === 'already-installed') console.log('데스크탑 오버레이 앱은 이미 설치돼 있습니다.');
      break;
    case 'unsupported':
      console.log(`데스크탑 오버레이 앱은 현재 Windows와 macOS만 지원합니다. 이 환경(${result.platform})에서는 건너뜁니다.`);
      break;
    default:
      console.log('데스크탑 오버레이 앱은 설치하지 못했습니다(선택 단계). CLI는 정상 동작합니다.');
      console.log(`  사유: ${result.message || result.stage || '알 수 없음'}`);
      // CLAW-134 이후 광고를 표시하는 창구는 오버레이뿐이다. 결과를 실패 시점에 말하지 않으면
      // 사용자는 적립이 0인 이유를 status를 실행해야 알게 된다 (CLAW-144).
      console.log('  ⚠ 오버레이가 없으면 광고가 표시되지 않아 포인트도 적립되지 않습니다.');
      console.log(`  다시 시도: ${userCommand('install')}`);
      console.log('  직접 설치: https://github.com/TJ-media/clawad-overlay/releases/latest');
      break;
  }
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

  // 설치 때 함께 넣었으므로 제거도 함께 한다(rules §7 원상복구). 오버레이 자체 제거
  // 프로그램이 자기 훅·설정을 정리한다. 실패해도 CLI 제거는 계속한다.
  const overlay = require('./overlay-install').uninstallOverlay({});
  if (overlay.status === 'removed') console.log(`데스크탑 오버레이 앱(${overlay.productName})을 제거했습니다.`);
  else if (overlay.status === 'failed') {
    console.log(`데스크탑 오버레이 앱을 제거하지 못했습니다. 사유: ${overlay.message}`);
    console.log(process.platform === 'darwin'
      ? '  Finder에서 사용자 홈의 응용 프로그램 폴더에 있는 Claw-Ad.app을 직접 지울 수 있습니다.'
      : '  Windows 설정 → 앱에서 직접 제거할 수 있습니다.');
  }

  // 0.1.11 이하에서 설치하고 곧바로 제거하는 경로. 설치를 거치지 않았으면 슬롯이 아직 우리
  // 것이므로 여기서도 되돌린다(rules §7). 설치가 이미 놓아줬으면 아무것도 걸리지 않는다.
  const released = releaseStatusLineSlot(settings);
  const hadHooks = hasActivityHooks(settings);
  if (!released && !hadHooks) {
    console.log('클로애드가 변경한 Claude 설정이 없습니다. 다른 설정은 건드리지 않습니다.');
    return;
  }

  removeActivityHooks(settings);
  writeJsonAtomic(SETTINGS_FILE, settings);
  if (hadHooks) console.log('활동 감지 훅을 제거했습니다.');
  if (released) {
    console.log(released.restored
      ? '기존 statusLine 설정을 원상복구했습니다.'
      : 'statusLine 설정을 제거했습니다 (설치 전에도 없었음).');
  }
  consumeStatusLineBackup();
  console.log('제거 완료. 클로애드 로컬 데이터는 보존됩니다.');
}

// 광고 창구가 오버레이 하나뿐이므로(CLAW-134) 일시중지는 **재고를 비우는 것**으로 실현한다.
// 오버레이는 별도 프로그램이라 우리 `paused` 파일을 읽지 않는다 — 캐시를 비우고 sync를 멈추면
// 표시할 광고가 남지 않는다. 즉시 효과가 있고 오버레이 버전에 의존하지 않는다(rules §7).
function discardBundleCache() {
  const file = process.env.CLAWAD_BUNDLES || path.join(DATA, 'bundles.json');
  const bundles = readJson(file, []);
  const count = Array.isArray(bundles) ? bundles.length : 0;
  if (!count) return 0;
  writeJsonAtomic(file, []);
  return count;
}

function pause() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(PAUSE_FILE, new Date().toISOString());
  syncScheduler.setPaused(true, { root: ROOT, data: DATA });
  const discarded = discardBundleCache();
  if (discarded) console.log(`받아둔 광고 ${discarded}건을 폐기했습니다.`);
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

// 광고 표시 창구가 오버레이 하나뿐이므로(CLAW-134) 상태에 함께 보여준다. 오버레이는 별도
// 프로그램이라 두 신호만 본다: 표준 설치 경로의 실행 파일, 그리고 지금 서피스를 쥐고 있는
// 살아 있는 소유자. 후자를 함께 보는 이유는 표준 경로 밖에서 실행하는 경우(개발 빌드 등)를
// "미설치"로 잘못 보고하지 않기 위해서다. 버전 비교는 오버레이 자체 자동 업데이트가 한다.
function overlayPresent() {
  try {
    if (require('./sync-runtime').lockHeldByLiveOwner(path.join(DATA, 'surface.lock'))) return true;
  } catch {}
  // 설치 경로는 플랫폼마다 다르다(Windows는 Programs\Claw-Ad\Claw-Ad.exe, macOS는 ~/Applications/Claw-Ad.app).
  // overlay-install이 그 판단을 갖고 있으므로 여기서 플랫폼을 다시 나누지 않고 target만 본다 (CLAW-92).
  try {
    return fs.existsSync(require('./overlay-install').installedPaths('Claw-Ad').target);
  } catch {
    return false;
  }
}

function status() {
  const settings = readJson(SETTINGS_FILE, {});
  const scheduled = syncScheduler.status({ root: ROOT, data: DATA });
  const syncState = readJson(path.join(DATA, 'sync-state.json'), {}) || {};
  const nextBase = syncState.lastRunAt || syncState.lastSuccessAt;
  const nextRun = nextBase && scheduled.installed && !scheduled.paused
    ? new Date(Date.parse(nextBase) + scheduled.intervalMinutes * 60000).toISOString()
    : null;
  console.log(`버전     : ${readJson(path.join(ROOT, 'package.json'), {}).version || '알 수 없음'}`);
  console.log(`설치됨   : ${hasActivityHooks(settings) ? '예' : '아니오'}`);
  console.log(`일시중지 : ${fs.existsSync(PAUSE_FILE) ? '예' : '아니오'}`);
  // 슬롯을 놓아주는 마이그레이션이 아직 안 돌았으면 알려준다. `install`을 다시 실행하면 복구된다.
  if (isClawadStatusLine(settings.statusLine)) {
    console.log('statusLine: 이전 버전이 점유 중 — install을 다시 실행하면 설치 전 설정으로 되돌립니다.');
  }
  console.log(`광고 표시: 데스크탑 오버레이 앱 (${overlayPresent() ? '확인됨' : '확인되지 않음 — 설치·실행 전에는 광고·적립이 발생하지 않습니다'})`);
  // 상한 도달은 정상 동작이다. 표시가 없으면 "왜 광고가 안 뜨지"를 사용자가 알 수 없다 (CLAW-150).
  const rewardSummary = readJson(path.join(DATA, 'reward-summary.json'), {}) || {};
  if (rewardSummary.dailyCapReached === true) {
    const resetsAt = typeof rewardSummary.dailyCapResetsAt === 'string' ? rewardSummary.dailyCapResetsAt : '';
    console.log(`일일 상한: 도달 — 오늘은 더 적립되지 않습니다${resetsAt ? ` (재개 ${resetsAt})` : ''}`);
  }
  // 표시한 노출 중 서버가 인정한 비율 (CLAW-164). 적립이 안 늘 때 원인을 여기서 좁힌다 —
  // 표시가 안 된 것인지, 표시는 됐는데 인정이 안 된 것인지가 갈린다.
  const outcomes = readJson(path.join(DATA, 'event-outcomes.json'), {}) || {};
  if (outcomes.version === 1 && outcomes.day === dayKey()) {
    const reasons = outcomes.rejected && typeof outcomes.rejected === 'object' ? outcomes.rejected : {};
    const breakdown = Object.entries(reasons)
      .sort(([, a], [, b]) => b - a)
      .map(([reason, count]) => `${reason} ${count}`)
      .join(', ');
    const rejectedTotal = Object.values(reasons).reduce((sum, count) => sum + count, 0);
    console.log(`오늘 업로드 결과: 인정 ${outcomes.accepted || 0}건 / 거절 ${rejectedTotal}건${breakdown ? ` (${breakdown})` : ''}`);
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
// install은 오버레이 설치(네트워크) 때문에 async다. 나머지는 동기 함수라 Promise.resolve로
// 받아도 동작이 같다. 실패 메시지·종료 코드는 두 경우 모두 같은 자리에서 처리한다.
Promise.resolve()
  .then(() => COMMANDS[command]())
  .catch((error) => {
    console.error(error && error.message ? error.message : '설치 관리 작업에 실패했습니다.');
    process.exit(1);
  });
