#!/usr/bin/env node
'use strict';
// 오버레이 노출 이벤트 스풀 수거 (CLAW-90).
//
// clawad-overlay(AGPL, 별도 프로그램)는 광고를 표시한 **사실만** `data/overlay-events/`에 스풀
// 파일로 남긴다. 채번·원장 append·유효 노출 구간 판정은 전부 이 모듈이 한다 — 오버레이는
// sequence·machineId·clientVersion을 만들지 않고 원장 로직을 갖지 않는다
// (docs/design/overlay-contract.md §3, CLAW-86의 "위임" 결정).
//
// 호출자는 오버레이의 즉시 트리거(CLI)와 주기 sync뿐이다. 수거는 at-least-once이며,
// 중복은 serveToken 대조로 막는다.
const fs = require('fs');
const path = require('path');
const { defaultDataDir } = require('./distribution-config');
const { getMachineId, readJson } = require('./machine');
const { acquireLockWithRetry, releaseLock, writeJsonAtomic } = require('./sync-runtime');
const { appendEventSummary, emptySummary, readSummary } = require('./ledger-summary');
const { loadActivity } = require('./work-activity-store');

const SPOOL_VERSION = 1;
const TRIGGER_VERSION = 1;
/** 오버레이가 만드는 스풀 파일명. 랜덤 hex 16바이트 — 그 외 이름은 우리 파일이 아니므로 파싱하지 않는다. */
const SPOOL_FILE_PATTERN = /^[0-9a-f]{32}\.json$/;
/** work-state 파일명(세션 해시). 활동 감지 훅(work-activity.js)이 쓰는 것과 같은 규칙이다. */
const SESSION_FILE_PATTERN = /^[0-9a-f]{32}\.json$/;
const FACT_CAMPAIGN_TYPES = new Set(['PAID', 'HOUSE', 'TEST']);
const LEDGER_LOCK_WAIT_MS = 2000;
const LEDGER_LOCK_RETRY_MS = 20;
const LEDGER_LOCK_STALE_MS = 5 * 1000;
const MAX_SERVE_TOKEN_LENGTH = 4096;
const CLIENT_VERSION = require('../package.json').version;

function paths(dataDir) {
  const data = dataDir || process.env.CLAWAD_DATA || defaultDataDir();
  return {
    data,
    spoolDir: process.env.CLAWAD_OVERLAY_SPOOL || path.join(data, 'overlay-events'),
    trigger: path.join(data, 'overlay-trigger.json'),
    bundles: process.env.CLAWAD_BUNDLES || path.join(data, 'bundles.json'),
    ledger: process.env.CLAWAD_LEDGER || path.join(data, 'ledger.jsonl'),
    ledgerLock: path.join(data, 'ledger.lock'),
    summary: path.join(data, 'ledger-summary.json'),
    pending: path.join(data, 'ledger-summary-pending.json'),
    sequence: path.join(data, 'sequence.json'),
    machine: process.env.CLAWAD_MACHINE || path.join(data, 'machine.json'),
    workState: path.join(data, 'work-state'),
  };
}

// 상한·보존기간·최소 시청 시간은 정책에서만 온다(rules §5). 정책을 읽지 못하면 수거하지 않는다 —
// 기본값으로 넘겨짚으면 정책 누락이 조용히 통과한다.
function policyValues() {
  try {
    const policy = require('../policy/policy').loadPolicy();
    return {
      minViewMs: policy.impression.minViewMs,
      staleActiveMs: policy.activity.staleActiveMs,
      maxFiles: policy.overlay.eventSpoolMaxFiles,
      retentionMs: policy.overlay.eventSpoolRetentionMs,
    };
  } catch {
    return null;
  }
}

function validSpoolEvent(value) {
  return Boolean(
    value && value.version === SPOOL_VERSION &&
    typeof value.serveToken === 'string' && value.serveToken.length > 0 &&
    value.serveToken.length <= MAX_SERVE_TOKEN_LENGTH &&
    Number.isFinite(value.renderStarted) &&
    Number.isFinite(value.displayStartedAt) && Number.isFinite(value.displayEndedAt) &&
    value.displayEndedAt > value.displayStartedAt &&
    // renderStarted는 표시 시작 신호이므로 표시 구간 시작보다 늦을 수 없다(privacy-design §1).
    // 이건 계약 스키마 검증이지 노출 인정 판정이 아니다 — 인정 구간(startedAt/endedAt)과 리워드는
    // renderStarted를 쓰지 않는다(rules §6).
    value.renderStarted <= value.displayStartedAt
  );
}

/** 스풀 파일 목록을 오래된 것부터 반환한다. 오버레이의 원자적 쓰기 중간 산물(.tmp)은 제외한다. */
function readSpool(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = [];
  for (const name of names) {
    if (name.endsWith('.tmp')) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    files.push({ file, mtimeMs: stat.mtimeMs, spooled: SPOOL_FILE_PATTERN.test(name) });
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch {}
}

/**
 * 스풀 위생: 보존기간을 넘긴 파일과 상한 초과분(오래된 것부터)을 폐기한다.
 * 오프라인이 길어져도 디렉터리가 무한히 자라지 않게 한다. 값은 정책에서만 온다.
 */
function purgeSpool(files, policy, now) {
  const fresh = [];
  let purged = 0;
  for (const entry of files) {
    if (now - entry.mtimeMs > policy.retentionMs) {
      removeFile(entry.file);
      purged += 1;
      continue;
    }
    fresh.push(entry);
  }
  const overflow = Math.max(0, fresh.length - policy.maxFiles);
  for (const entry of fresh.slice(0, overflow)) {
    removeFile(entry.file);
    purged += 1;
  }
  return { purged, remaining: fresh.slice(overflow) };
}

/** 원장에 이미 있는 serveToken. 수거는 at-least-once이므로 이 집합이 중복 인정을 막는다. */
function usedServeTokens(ledgerFile) {
  const tokens = new Set();
  let raw;
  try { raw = fs.readFileSync(ledgerFile, 'utf8').replace(/^﻿/, ''); } catch { return tokens; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event.serveToken === 'string') tokens.add(event.serveToken);
    } catch {}
  }
  return tokens;
}

/**
 * 표시 구간과 겹치는 활성 구간 중 가장 긴 교집합을 찾는다 = 유효 노출 구간.
 * 오버레이는 세션 개념이 없으므로
 * work-state의 모든 세션을 훑되, 교집합은 **하나의 활성 구간 안에서** 계산한다 — 서로 떨어진
 * 구간을 합쳐 최소 시청 시간을 채우지 않는다.
 */
function bestActiveOverlap(workStateDir, display, now, staleActiveMs) {
  let names = [];
  try { names = fs.readdirSync(workStateDir); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!SESSION_FILE_PATTERN.test(name)) continue;
    const activity = loadActivity(workStateDir, name.slice(0, -5), now, staleActiveMs);
    const intervals = [...activity.intervals];
    if (activity.active && Number.isFinite(activity.startedAt)) {
      intervals.push({ startedAt: activity.startedAt, endedAt: now });
    }
    for (const interval of intervals) {
      const startedAt = Math.max(display.startedAt, interval.startedAt);
      const endedAt = Math.min(display.endedAt, interval.endedAt);
      if (endedAt <= startedAt) continue;
      if (!best || endedAt - startedAt > best.endedAt - best.startedAt) best = { startedAt, endedAt };
    }
  }
  return best;
}

function nextSequence(summary, sequenceFile) {
  const stored = readJson(sequenceFile, null);
  const storedValue = stored && Number.isInteger(stored.nextSequence) ? stored.nextSequence : 0;
  return Math.max(summary.nextSequence, storedValue) + 1;
}

/** serveToken은 단일 사용이다. 인정된 토큰의 번들은 즉시 후보에서 제거한다. */
function removeConsumedBundle(bundlesFile, serveToken) {
  const bundles = readJson(bundlesFile, []);
  if (!Array.isArray(bundles)) return;
  const remaining = bundles.filter((bundle) => !bundle || bundle.serveToken !== serveToken);
  if (remaining.length !== bundles.length) writeJsonAtomic(bundlesFile, remaining, 0o600);
}

function bundleIndex(bundlesFile) {
  const bundles = readJson(bundlesFile, []);
  const index = new Map();
  if (!Array.isArray(bundles)) return index;
  for (const bundle of bundles) {
    if (bundle && typeof bundle.serveToken === 'string') index.set(bundle.serveToken, bundle);
  }
  return index;
}

/**
 * 스풀을 수거해 원장에 기록한다. 반환값은 진단용이며 금액·잔액을 담지 않는다.
 * 실패는 예외가 아니라 skipped 사유로 돌려준다 — 트리거는 best-effort이고 다음 주기 sync가 재시도한다.
 */
function collectOverlayEvents(options = {}) {
  const now = options.now ?? Date.now();
  const p = paths(options.dataDir);
  const empty = { collected: 0, purged: 0, dropped: {} };
  const policy = policyValues();
  if (!policy) return { ...empty, skipped: 'POLICY_UNAVAILABLE' };

  const files = readSpool(p.spoolDir);
  if (!files.length) return empty;
  const { purged, remaining } = purgeSpool(files, policy, now);
  if (!remaining.length) return { ...empty, purged };
  // append와 요약 갱신 사이에서 죽은 흔적이 있으면 sync의 원장 복구가 먼저다.
  if (fs.existsSync(p.pending)) return { ...empty, purged, skipped: 'LEDGER_RECOVERY_PENDING' };
  if (!acquireLockWithRetry(p.ledgerLock, {
    timeoutMs: LEDGER_LOCK_WAIT_MS, retryMs: LEDGER_LOCK_RETRY_MS, staleMs: LEDGER_LOCK_STALE_MS,
  })) {
    return { ...empty, purged, skipped: 'LEDGER_BUSY' };
  }

  const dropped = {};
  const drop = (reason) => { dropped[reason] = (dropped[reason] || 0) + 1; };
  let collected = 0;
  try {
    let machineId;
    try { machineId = getMachineId(p.machine); } catch { return { ...empty, purged, skipped: 'MACHINE_ID_UNAVAILABLE' }; }
    let summary = readSummary(p.summary) || emptySummary(now);
    const used = usedServeTokens(p.ledger);
    const bundles = bundleIndex(p.bundles);

    for (const entry of remaining) {
      // 우리 스풀 파일이 아니면 읽지도 지우지도 않는다. 오래되면 보존기간이 정리한다.
      if (!entry.spooled) continue;
      const spooled = readJson(entry.file, null);
      if (!validSpoolEvent(spooled)) {
        removeFile(entry.file);
        drop('MALFORMED');
        continue;
      }
      if (used.has(spooled.serveToken)) {
        removeFile(entry.file);
        drop('DUPLICATE');
        continue;
      }
      const bundle = bundles.get(spooled.serveToken);
      if (!bundle || !bundle.ad || !FACT_CAMPAIGN_TYPES.has(bundle.ad.campaignType)) {
        removeFile(entry.file);
        drop('UNKNOWN_TOKEN');
        continue;
      }
      const viewMs = typeof bundle.minViewMs === 'number' ? bundle.minViewMs : policy.minViewMs;
      const interval = bestActiveOverlap(
        p.workState,
        { startedAt: spooled.displayStartedAt, endedAt: spooled.displayEndedAt },
        now,
        policy.staleActiveMs,
      );
      if (!interval || interval.endedAt - interval.startedAt < viewMs) {
        removeFile(entry.file);
        drop('BELOW_MIN_VIEW');
        continue;
      }

      // 원장 이벤트는 허용목록 8필드만 갖는다. 스풀에 다른 키가 있어도 싣지 않는다(privacy-design §1.1).
      const event = {
        serveToken: spooled.serveToken,
        sequence: nextSequence(summary, p.sequence),
        machineId,
        renderStarted: spooled.renderStarted,
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        clientVersion: CLIENT_VERSION,
        synced: false,
      };
      // 의도 파일은 append와 요약 갱신 사이의 강제 종료를 sync가 복구하게 한다.
      writeJsonAtomic(p.pending, { event, createdAt: now }, 0o600);
      fs.appendFileSync(p.ledger, JSON.stringify(event) + '\n');
      summary = appendEventSummary(summary, event, now);
      writeJsonAtomic(p.summary, summary, 0o600);
      writeJsonAtomic(p.sequence, { nextSequence: event.sequence }, 0o600);
      used.add(event.serveToken);
      bundles.delete(event.serveToken);
      removeFile(entry.file);
      collected += 1;

      let removedBundle = false;
      try {
        removeConsumedBundle(p.bundles, event.serveToken);
        removedBundle = true;
      } catch {}
      if (!removedBundle) {
        // 캐시 커밋에 실패하면 pending을 남겨 sync가 원장 기준으로 복구하게 한다. 남은 스풀은 다음 기회에.
        return { collected, purged, dropped, skipped: 'BUNDLE_COMMIT_FAILED' };
      }
      removeFile(p.pending);
    }
  } finally {
    releaseLock(p.ledgerLock);
  }
  return { collected, purged, dropped };
}

/**
 * 오버레이가 수거를 즉시 트리거할 때 실행할 커맨드를 남긴다 (overlay-contract.md §3.2).
 * sync가 주기마다 갱신하므로 재설치 없이 항상 현재 설치본을 가리킨다.
 * 로컬 협약 파일이며 서버로 전송하지 않는다.
 */
function writeTriggerPointer(options = {}) {
  const p = paths(options.dataDir);
  const value = {
    version: TRIGGER_VERSION,
    node: process.execPath,
    script: path.join(__dirname, 'overlay-events.js'),
    args: ['collect'],
    clientVersion: CLIENT_VERSION,
  };
  const current = readJson(p.trigger, null);
  if (current && current.version === value.version && current.node === value.node &&
      current.script === value.script && current.clientVersion === value.clientVersion) {
    return false;
  }
  writeJsonAtomic(p.trigger, value, 0o600);
  return true;
}

function formatResult(result) {
  if (result.skipped) return `오버레이 노출 이벤트 수거를 건너뜁니다 (${result.skipped})`;
  const reasons = Object.entries(result.dropped).map(([reason, count]) => `${reason}:${count}`).join(', ');
  const droppedTotal = Object.values(result.dropped).reduce((sum, count) => sum + count, 0);
  return `오버레이 노출 이벤트 수거: 인정 ${result.collected}건, 미인정 ${droppedTotal}건${reasons ? ` (${reasons})` : ''}, 정리 ${result.purged}건`;
}

if (require.main === module) {
  const command = process.argv[2] || 'collect';
  if (command !== 'collect') {
    console.error('사용법: node client/overlay-events.js collect');
    process.exitCode = 1;
  } else {
    // 트리거 실패는 사용자 오류가 아니다. 사유만 남기고 0으로 끝내 다음 주기 sync가 이어받게 한다.
    console.log(formatResult(collectOverlayEvents()));
  }
}

module.exports = { collectOverlayEvents, formatResult, writeTriggerPointer };
