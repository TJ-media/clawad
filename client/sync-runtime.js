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
  releaseLock,
  writeJsonAtomic,
};
