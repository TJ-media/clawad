'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./machine');
const { acquireLockWithRetry, releaseLock, writeJsonAtomic } = require('./sync-runtime');

const VERSION = 1;
const MAX_INTERVALS = 32;
/** 세션 해시 파일명. 이 형식이 아니면 우리 파일이 아니므로 정리 대상에서 제외한다(잠금 파일 포함). */
const SESSION_FILE_PATTERN = /^[0-9a-f]{32}\.json$/;

function activityFile(dir, key) {
  return path.join(dir, `${key}.json`);
}

function validInterval(value) {
  return Boolean(value && Number.isFinite(value.startedAt) && Number.isFinite(value.endedAt) && value.endedAt >= value.startedAt);
}

function validActivity(value) {
  return Boolean(value && value.version === VERSION && typeof value.active === 'boolean' &&
    (!value.active || Number.isFinite(value.startedAt)) && Array.isArray(value.intervals) &&
    value.intervals.every(validInterval) && Number.isFinite(value.updatedAt));
}

function emptyActivity(now) {
  return { version: VERSION, active: false, intervals: [], updatedAt: now };
}

function loadActivity(dir, key, now, staleMs) {
  const file = activityFile(dir, key);
  const activity = readJson(file, null);
  if (!validActivity(activity)) return emptyActivity(now);
  if (activity.active && now - activity.startedAt > staleMs) {
    return {
      ...activity,
      active: false,
      intervals: [...activity.intervals, { startedAt: activity.startedAt, endedAt: activity.startedAt + staleMs }].slice(-MAX_INTERVALS),
      updatedAt: now,
    };
  }
  return activity;
}

function updateActivity(dir, key, action, now, staleMs) {
  const file = activityFile(dir, key);
  const lockFile = `${file}.lock`;
  if (!acquireLockWithRetry(lockFile, { timeoutMs: 250, retryMs: 10, staleMs: 5000 })) return false;
  try {
    const current = loadActivity(dir, key, now, staleMs);
    let next = current;
    if (action === 'start' && !current.active) {
      next = { ...current, active: true, startedAt: now, updatedAt: now };
    }
    if (action === 'stop' && current.active) {
      next = {
        ...current,
        active: false,
        intervals: [...current.intervals, { startedAt: current.startedAt, endedAt: now }].slice(-MAX_INTERVALS),
        updatedAt: now,
      };
      delete next.startedAt;
    }
    writeJsonAtomic(file, next, 0o600);
    return true;
  } finally {
    releaseLock(lockFile);
  }
}

function activeInterval(activity, now) {
  if (activity.active) return { startedAt: activity.startedAt, endedAt: now };
  return activity.intervals.length ? activity.intervals[activity.intervals.length - 1] : null;
}

/**
 * 오래된 활동 상태 파일을 정리한다 (CLAW-143).
 *
 * 훅이 세션마다 파일을 만들지만 지우는 코드가 없어 무한히 쌓인다. 다만 이 파일들은 단순
 * 로그가 아니라 **인정 노출 판정의 입력**이다 — 수거(overlay-events.js)가 스풀의 표시 구간과
 * 교집합을 낼 때 읽는다. 아직 수거되지 않은 스풀이 참조할 구간을 지우면 인정될 노출이
 * BELOW_MIN_VIEW로 조용히 사라진다. 그래서 retentionMs는 정책이 스풀 보존기간 이상으로
 * 강제하며(policy.js), 호출도 수거가 끝난 뒤에 한다.
 *
 * 파일 하나가 실패해도 나머지 정리는 계속한다 — 위생 작업이 sync를 실패시키면 안 된다(규칙 §8).
 */
function purgeActivity(dir, now, retentionMs) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { removed: 0, kept: 0 }; }
  let removed = 0;
  let kept = 0;
  for (const name of names) {
    if (!SESSION_FILE_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    // 최근 파일은 내용을 읽지 않는다. mtime은 updatedAt 이상이라 이 선별로 지울 것을 놓치지 않고,
    // 세션이 수백 개여도 파싱 비용이 들지 않는다.
    if (now - stat.mtimeMs <= retentionMs) {
      kept += 1;
      continue;
    }
    // 진행 중 표시가 남은 세션은 지우지 않는다. 긴 턴을 끊을 수 있고, Stop을 못 받아 굳은
    // 좀비 세션은 표시 판정 쪽에서 다룰 문제다(CLAW-142). 여기서 지우면 원인이 가려진다.
    const activity = readJson(file, null);
    if (validActivity(activity) && activity.active === true) {
      kept += 1;
      continue;
    }
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      kept += 1;
    }
  }
  return { removed, kept };
}

module.exports = { activeInterval, activityFile, loadActivity, purgeActivity, updateActivity };
