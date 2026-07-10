'use strict';
// client/machine.js — 가명 머신 ID 생성 (CLAW-15 §6, CLAW-24).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getMachineId } = require('../client/machine');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-machine-'));
  return path.join(dir, 'nested', 'machine.json');
}

test('없으면 32자리 hex 가명값을 만들어 저장한다', () => {
  const file = tmpFile();
  const id = getMachineId(file);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).machineId, id);
});

test('두 번 호출해도 같은 값을 돌려준다', () => {
  const file = tmpFile();
  assert.strictEqual(getMachineId(file), getMachineId(file));
});

test('sync가 먼저 실행돼도 부트스트랩된다 (statusline 선행 불필요)', () => {
  const file = tmpFile();
  assert.ok(!fs.existsSync(file));
  assert.match(getMachineId(file), /^[0-9a-f]{32}$/);
});

test('손상된 machine.json은 새 값으로 교체한다', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not-json{{{');
  assert.match(getMachineId(file), /^[0-9a-f]{32}$/);
});

test('하드웨어 식별자 형식(MAC 등)은 유효한 값으로 보지 않는다', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ machineId: '00:11:22:33:44:55' }));
  const id = getMachineId(file);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notStrictEqual(id, '00:11:22:33:44:55');
});

test('BOM이 붙은 파일도 읽는다 (Windows 도구 호환)', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const id = 'a'.repeat(32);
  fs.writeFileSync(file, '﻿' + JSON.stringify({ machineId: id }));
  assert.strictEqual(getMachineId(file), id);
});

test('하드웨어 식별자를 수집하는 코드가 없다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'client', 'machine.js'), 'utf8');
  for (const forbidden of ['networkInterfaces', 'hostname', 'cpus', 'userInfo', 'machineIdSync']) {
    assert.ok(!src.includes(forbidden), `machine.js가 ${forbidden}를 쓰면 안 된다`);
  }
});
