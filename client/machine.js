'use strict';
// 로컬 가명 머신 식별자 (CLAW-15 §6).
//
// 하드웨어 식별자(MAC 주소·디스크 시리얼·하드웨어 UUID)를 쓰지 않는다.
// 로컬에서 난수로 생성한 가명값이므로 동일인·동일 기기를 확정 식별한다고 표현하지 않는다.
//
// statusline(핫패스)과 sync가 모두 쓴다. 어느 쪽이 먼저 실행돼도 부트스트랩이 되도록
// 여기서 생성까지 책임진다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { acquireLockWithRetry, releaseLock, writeJsonAtomic } = require('./sync-runtime');

function readJson(file, fallback) {
  try {
    // Windows 도구들이 BOM을 붙이는 경우가 있어 제거 후 파싱
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/** 없으면 만들어서 반환한다. 서버는 32자리 소문자 hex만 받는다. */
function getMachineId(machineFile) {
  const existing = readJson(machineFile, null);
  if (existing && typeof existing.machineId === 'string' && /^[0-9a-f]{32}$/.test(existing.machineId)) {
    return existing.machineId;
  }
  const lockFile = `${machineFile}.lock`;
  if (!acquireLockWithRetry(lockFile, { timeoutMs: 250, retryMs: 10, staleMs: 5000 })) {
    const concurrent = readJson(machineFile, null);
    if (concurrent && typeof concurrent.machineId === 'string' && /^[0-9a-f]{32}$/.test(concurrent.machineId)) {
      return concurrent.machineId;
    }
    throw new Error('MACHINE_ID_UNAVAILABLE');
  }
  try {
    const afterLock = readJson(machineFile, null);
    if (afterLock && typeof afterLock.machineId === 'string' && /^[0-9a-f]{32}$/.test(afterLock.machineId)) {
      return afterLock.machineId;
    }
    const machineId = crypto.randomBytes(16).toString('hex');
    writeJsonAtomic(machineFile, { machineId }, 0o600);
    return machineId;
  } finally {
    releaseLock(lockFile);
  }
}

module.exports = { getMachineId, readJson };
