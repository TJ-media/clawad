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

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || path.join(ROOT, 'data');
const PAUSE_FILE = path.join(DATA, 'paused');
const SETTINGS_FILE = process.env.CLAWAD_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_FILE = path.join(DATA, 'statusline-backup.json');

const STATUSLINE_COMMAND = `node ${path.join(ROOT, 'client', 'statusline.js')}`;

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
  return Boolean(statusLine && typeof statusLine.command === 'string' && statusLine.command.includes('clawad'));
}

function install() {
  const settings = readJson(SETTINGS_FILE, {});
  const existing = settings.statusLine;

  if (isClawadStatusLine(existing)) {
    console.log('이미 설치되어 있습니다.');
    return;
  }

  console.log('클로애드를 설치하면 다음이 변경됩니다:');
  console.log(`  파일: ${SETTINGS_FILE}`);
  console.log(`  설정: statusLine.command → ${STATUSLINE_COMMAND}`);
  if (existing) {
    console.log(`  기존 statusLine 설정을 ${BACKUP_FILE}에 백업합니다.`);
  } else {
    console.log('  기존 statusLine 설정은 없습니다. 제거 시 statusLine 항목을 삭제합니다.');
  }
  console.log('  상태줄에는 [광고] 표기가 붙은 광고 한 줄과 예상 적립 포인트가 표시됩니다.');
  console.log('  프롬프트·코드·파일 경로·터미널 명령어는 수집하지 않습니다.');
  console.log('');

  // 원상복구를 위해 기존 값을 그대로 보관한다. 없었으면 없었다는 사실을 기록한다.
  writeJson(BACKUP_FILE, { hadStatusLine: existing !== undefined, statusLine: existing ?? null });

  settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND };
  writeJson(SETTINGS_FILE, settings);
  console.log('설치 완료. 제거하려면: node client/install.js uninstall');
}

function uninstall() {
  const settings = readJson(SETTINGS_FILE, {});
  if (!isClawadStatusLine(settings.statusLine)) {
    console.log('클로애드 statusLine 설정이 없습니다. 다른 설정을 건드리지 않습니다.');
    return;
  }

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
  console.log(`제거 완료. 로컬 데이터는 ${DATA}에 남아 있습니다.`);
}

function pause() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(PAUSE_FILE, new Date().toISOString());
  console.log('광고 표시를 일시중지했습니다. 해제: node client/install.js resume');
}

function resume() {
  try {
    fs.unlinkSync(PAUSE_FILE);
    console.log('광고 표시를 재개했습니다.');
  } catch {
    console.log('일시중지 상태가 아닙니다.');
  }
}

function status() {
  const settings = readJson(SETTINGS_FILE, {});
  console.log(`설치됨   : ${isClawadStatusLine(settings.statusLine) ? '예' : '아니오'}`);
  console.log(`일시중지 : ${fs.existsSync(PAUSE_FILE) ? '예' : '아니오'}`);
  console.log(`설정 파일: ${SETTINGS_FILE}`);
}

const COMMANDS = { install, uninstall, pause, resume, status };
const command = process.argv[2];

if (!command || !COMMANDS[command]) {
  console.error('사용법: node client/install.js <install|uninstall|pause|resume|status>');
  process.exit(1);
}
COMMANDS[command]();
