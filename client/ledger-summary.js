'use strict';

const fs = require('fs');
const { readJson } = require('./machine');
const { writeJsonAtomic } = require('./sync-runtime');
const policy = require('../policy/policy');

const SUMMARY_VERSION = 1;

// 서버와 같은 정책일 경계(KST 06:00)로 하루를 센다 (CLAW-271, CLAW-151). UTC 자정으로 세면
// "오늘 업로드 결과" 진단 표시가 KST 06~09시 구간에서 서버와 다른 하루를 센다.
// 진단 표시 전용이라 정책 로드 실패 시에는 이전 동작(UTC 자정, shift 0)으로 둔다 — 금액 판정과 무관.
let policyDayShiftMinutes = 0;
try { policyDayShiftMinutes = policy.loadPolicy().reward.policyDayShiftMinutes; } catch {}

function dayKey(value = Date.now()) {
  return policy.policyDayKey(new Date(value), policyDayShiftMinutes);
}

function emptySummary(now = Date.now()) {
  return {
    version: SUMMARY_VERSION,
    totalImpressions: 0,
    unsyncedImpressions: 0,
    today: dayKey(now),
    todayImpressions: 0,
    nextSequence: 0,
    updatedAt: now,
  };
}

function validSummary(value) {
  return Boolean(
    value &&
    value.version === SUMMARY_VERSION &&
    Number.isInteger(value.totalImpressions) && value.totalImpressions >= 0 &&
    (value.unsyncedImpressions === undefined || (Number.isInteger(value.unsyncedImpressions) && value.unsyncedImpressions >= 0)) &&
    typeof value.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.today) &&
    Number.isInteger(value.todayImpressions) && value.todayImpressions >= 0 &&
    Number.isInteger(value.nextSequence) && value.nextSequence >= 0 &&
    Number.isFinite(value.updatedAt)
  );
}

function readSummary(file) {
  const summary = readJson(file, null);
  return validSummary(summary) ? { ...summary, unsyncedImpressions: summary.unsyncedImpressions ?? summary.totalImpressions } : null;
}

function normalizedSummary(summary, now = Date.now()) {
  const currentDay = dayKey(now);
  if (summary.today === currentDay) return summary;
  return { ...summary, today: currentDay, todayImpressions: 0, updatedAt: now };
}

function appendEventSummary(summary, event, now = Date.now()) {
  const next = normalizedSummary(summary, now);
  const eventDay = dayKey(event.startedAt);
  return {
    ...next,
    totalImpressions: next.totalImpressions + 1,
    unsyncedImpressions: next.unsyncedImpressions + (event.synced ? 0 : 1),
    todayImpressions: next.todayImpressions + (eventDay === next.today ? 1 : 0),
    nextSequence: Math.max(next.nextSequence, event.sequence),
    updatedAt: now,
  };
}

function rebuildSummary(ledgerFile, summaryFile, now = Date.now()) {
  const summary = emptySummary(now);
  try {
    for (const line of fs.readFileSync(ledgerFile, 'utf8').replace(/^﻿/, '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        summary.totalImpressions += 1;
        if (!event.synced) summary.unsyncedImpressions += 1;
        if (dayKey(event.startedAt) === summary.today) summary.todayImpressions += 1;
        if (Number.isInteger(event.sequence)) summary.nextSequence = Math.max(summary.nextSequence, event.sequence);
      } catch {}
    }
  } catch {}
  writeJsonAtomic(summaryFile, summary, 0o600);
  return summary;
}

module.exports = {
  appendEventSummary,
  dayKey,
  emptySummary,
  readSummary,
  rebuildSummary,
  validSummary,
};
