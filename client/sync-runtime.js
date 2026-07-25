'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STALE_MS = 15 * 60 * 1000;

function writeJsonAtomic(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode });
    if (mode) {
      try { fs.chmodSync(temp, mode); } catch {}
    }
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function acquireLock(file, options = {}) {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const lock = readLock(file);
      const startedAt = Date.parse(lock && lock.startedAt);
      let fallbackStartedAt = now;
      try { fallbackStartedAt = fs.statSync(file).mtimeMs; } catch {}
      const ageBase = Number.isFinite(startedAt) ? startedAt : fallbackStartedAt;
      const expired = now - ageBase > staleMs;
      const validPid = Boolean(lock && Number.isInteger(lock.pid) && lock.pid > 0);
      if (validPid && isProcessAlive(lock.pid)) return false;
      if (!validPid && !expired) return false;
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return false;
}

/**
 * 락이 살아 있는 소유자에게 잡혀 있는지 읽기 전용으로 판정한다 (CLAW-91).
 * acquireLock이 "획득 불가"로 보는 조건과 같다 — 소유자가 아닌 프로세스가 락을 가져가거나
 * 지우지 않고 상태만 확인할 때 쓴다. 파일이 없으면 미보유다.
 *
 * pid가 살아 있으면 경과 시간으로 만료 판정하지 않는다. 상주 프로그램은 락을 며칠씩 들고
 * 있으므로, 나이로 만료시키면 소유자가 멀쩡히 광고를 띄우는 동안 다른 서피스가 이어받아
 * 이중 표시·이중 계상이 된다.
 */
function lockHeldByLiveOwner(file, options = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  const lock = readLock(file);
  if (lock && Number.isInteger(lock.pid) && lock.pid > 0) return isProcessAlive(lock.pid);
  // 소유자를 확인할 수 없는 락(손상·pid 없음)은 최근에 쓰인 것만 유효로 본다.
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const startedAt = Date.parse(lock && lock.startedAt);
  const ageBase = Number.isFinite(startedAt) ? startedAt : stat.mtimeMs;
  return now - ageBase <= staleMs;
}

function waitSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLockWithRetry(file, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;
  const retryMs = options.retryMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  do {
    if (acquireLock(file, { staleMs: options.staleMs })) return true;
    if (Date.now() >= deadline) return false;
    waitSync(Math.min(retryMs, Math.max(0, deadline - Date.now())));
  } while (true);
}

function releaseLock(file) {
  const lock = readLock(file);
  if (lock && lock.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch {}
}

function classifyError(error) {
  if (error && error.syncCode) return { code: error.syncCode, message: error.message };
  if (error && (error.name === 'TypeError' || error.cause)) {
    return { code: 'NETWORK_UNAVAILABLE', message: '서버에 연결할 수 없습니다. 다음 주기에 다시 시도합니다.' };
  }
  return { code: 'SYNC_FAILED', message: '동기화에 실패했습니다. 상태를 확인한 뒤 다시 시도합니다.' };
}

class SyncError extends Error {
  constructor(syncCode, message) {
    super(message);
    this.name = 'SyncError';
    this.syncCode = syncCode;
  }
}

module.exports = {
  DEFAULT_STALE_MS,
  SyncError,
  acquireLock,
  acquireLockWithRetry,
  classifyError,
  lockHeldByLiveOwner,
  releaseLock,
  writeJsonAtomic,
};
