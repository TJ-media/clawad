'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./machine');
const { acquireLockWithRetry, releaseLock, writeJsonAtomic } = require('./sync-runtime');

const VERSION = 1;
const MAX_INTERVALS = 32;

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

module.exports = { activeInterval, activityFile, loadActivity, updateActivity };
