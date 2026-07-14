#!/usr/bin/env node
// clawad — Claude Code statusLine 훅 (CLAW-24, CLAW-51, CLAW-53).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || path.join(ROOT, 'data');
const BUNDLES_FILE = process.env.CLAWAD_BUNDLES || path.join(DATA, 'bundles.json');
const LEGACY_STATE_FILE = path.join(DATA, 'state.json');
const SESSION_STATE_DIR = path.join(DATA, 'session-state');
const WORK_STATE_DIR = path.join(DATA, 'work-state');
const SEQUENCE_FILE = path.join(DATA, 'sequence.json');
const LEDGER_FILE = process.env.CLAWAD_LEDGER || path.join(DATA, 'ledger.jsonl');
const LEDGER_LOCK_FILE = path.join(DATA, 'ledger.lock');
const SUMMARY_FILE = path.join(DATA, 'ledger-summary.json');
const PENDING_FILE = path.join(DATA, 'ledger-summary-pending.json');
const MACHINE_FILE = path.join(DATA, 'machine.json');
const PAUSE_FILE = path.join(DATA, 'paused');
const CLIENT_VERSION = require('../package.json').version;
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const LEDGER_LOCK_WAIT_MS = 250;
const LEDGER_LOCK_STALE_MS = 5 * 1000;

let pointsPerThousand = 0;
let minViewMs = 5000;
let rotateMs = 15000;
let staleActiveMs = 120000;
try {
  const policy = require('../policy/policy').loadPolicy();
  pointsPerThousand = policy.reward.rewardPerThousandAcceptedImpressions;
  minViewMs = policy.impression.minViewMs;
  rotateMs = policy.statusLine.adRotateMs;
  staleActiveMs = policy.activity.staleActiveMs;
} catch {}

const { getMachineId, readJson } = require('./machine');
const { acquireLockWithRetry, releaseLock, writeJsonAtomic } = require('./sync-runtime');
const { appendEventSummary, emptySummary, readSummary } = require('./ledger-summary');
const { activeInterval, loadActivity } = require('./work-activity-store');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s) => `\x1b[1;33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function emitAndExit(line) {
  console.log(line);
  process.exit(0);
}

function readSessionId() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    const sessionId = parsed && parsed.session_id;
    if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 256) return null;
    return /[\u0000-\u001f\u007f]/.test(sessionId) ? null : sessionId;
  } catch {
    return null;
  }
}

function sessionKey(sessionId) {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

function sessionFile(key) {
  return path.join(SESSION_STATE_DIR, `${key}.json`);
}

function validSessionState(value) {
  return Boolean(value && typeof value.serveToken === 'string' && Number.isFinite(value.shownAt) &&
    typeof value.counted === 'boolean' && Number.isFinite(value.updatedAt));
}

function loadSessionStates(now) {
  const states = new Map();
  let names = [];
  try { names = fs.readdirSync(SESSION_STATE_DIR); } catch {}
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    const file = path.join(SESSION_STATE_DIR, name);
    const state = readJson(file, null);
    if (!validSessionState(state) || now - state.updatedAt > SESSION_STATE_TTL_MS) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    states.set(name.slice(0, -5), state);
  }
  return states;
}

function migrateLegacyState(key, now) {
  const legacy = readJson(LEGACY_STATE_FILE, null);
  if (!legacy || typeof legacy.serveToken !== 'string' || !Number.isFinite(legacy.shownAt)) return null;
  const migrated = { serveToken: legacy.serveToken, shownAt: legacy.shownAt, counted: Boolean(legacy.counted), updatedAt: now };
  writeJsonAtomic(sessionFile(key), migrated, 0o600);
  if (Number.isInteger(legacy.seq) && legacy.seq >= 0) writeJsonAtomic(SEQUENCE_FILE, { nextSequence: legacy.seq }, 0o600);
  try { fs.unlinkSync(LEGACY_STATE_FILE); } catch {}
  return migrated;
}

function chooseBundle(valid, state, states, key, now) {
  const current = state && valid.find((bundle) => bundle.serveToken === state.serveToken);
  if (current && now - state.shownAt < rotateMs) return current;
  const owned = new Set([...states].filter(([otherKey]) => otherKey !== key).map(([, other]) => other.serveToken));
  const start = current ? valid.indexOf(current) + 1 : 0;
  for (let offset = 0; offset < valid.length; offset += 1) {
    const candidate = valid[(start + offset) % valid.length];
    if (!owned.has(candidate.serveToken)) return candidate;
  }
  return current || null;
}

function loadHotSummary(now) {
  const summary = readSummary(SUMMARY_FILE);
  if (summary) return summary;
  // 기존 원장은 sync에서만 재구축한다. statusLine은 대용량 원장을 읽지 않는다.
  if (fs.existsSync(LEDGER_FILE) || fs.existsSync(PENDING_FILE)) return null;
  const initial = emptySummary(now);
  writeJsonAtomic(SUMMARY_FILE, initial, 0o600);
  return initial;
}

function nextSequence(summary) {
  const stored = readJson(SEQUENCE_FILE, null);
  const storedValue = stored && Number.isInteger(stored.nextSequence) ? stored.nextSequence : 0;
  return Math.max(summary.nextSequence, storedValue) + 1;
}

function render(bundle, summary) {
  const estPoints = (impressions) => Math.floor((impressions * pointsPerThousand) / 1000);
  const fmt = (value) => value.toLocaleString('ko-KR');
  const text = safeDisplayText(bundle.ad.text, 120);
  const brand = safeDisplayText(bundle.ad.brand, 60);
  const adText = supportsHyperlinks() && safeClickUrl(bundle.clickUrl) ? hyperlink(bundle.clickUrl, text) : text;
  return `${yellow('[광고]')} ${adText} ${dim('·')} ${cyan(brand)} ${dim('·')} ` +
    `${green(`예상 오늘 ${fmt(estPoints(summary.todayImpressions))}P`)} ${dim(`· 누적 예상 ${fmt(estPoints(summary.totalImpressions))}P`)}`;
}

function safeDisplayText(value, maxLength) {
  return String(value || '')
    .replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength) || '광고';
}

function safeClickUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function supportsHyperlinks(env = process.env) {
  if (env.CLAWAD_DISABLE_HYPERLINK === '1' || env.SSH_CONNECTION || env.TMUX || env.TERM === 'dumb') return false;
  return Boolean(env.WT_SESSION || env.KITTY_WINDOW_ID || env.VTE_VERSION ||
    ['iTerm.app', 'vscode', 'WezTerm', 'Hyper'].includes(env.TERM_PROGRAM));
}

function hyperlink(url, text) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function workIntervalForDisplay(key, state, now) {
  const activity = loadActivity(WORK_STATE_DIR, key, now, staleActiveMs);
  const interval = activeInterval(activity, now);
  if (!interval) return null;
  const startedAt = Math.max(state.shownAt, interval.startedAt);
  const endedAt = Math.min(now, interval.endedAt);
  return endedAt > startedAt ? { startedAt, endedAt, active: activity.active } : null;
}

const inputSessionId = readSessionId();
if (fs.existsSync(PAUSE_FILE)) emitAndExit(dim('clawad: 광고 일시중지됨 (npm run clawad:resume)'));
fs.mkdirSync(DATA, { recursive: true });
const now = Date.now();
let machineId;
try { machineId = getMachineId(MACHINE_FILE); } catch { emitAndExit(dim('clawad: 로컬 상태 준비 중')); }
const bundles = readJson(BUNDLES_FILE, []);
const valid = Array.isArray(bundles) ? bundles.filter((bundle) => bundle && bundle.expiresAt > now && bundle.ad) : [];
if (!valid.length) emitAndExit(dim('clawad: 광고 준비 중 (sync 대기)'));

let summary = loadHotSummary(now);
if (!inputSessionId) emitAndExit(render(valid[0], summary || emptySummary(now)));

const key = sessionKey(inputSessionId);
let displayedBundle = null;
if (acquireLockWithRetry(LEDGER_LOCK_FILE, { timeoutMs: LEDGER_LOCK_WAIT_MS, retryMs: 10, staleMs: LEDGER_LOCK_STALE_MS })) {
  try {
    fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
    const states = loadSessionStates(now);
    let state = states.get(key) || migrateLegacyState(key, now);
    if (state) states.set(key, state);
    const bundle = chooseBundle(valid, state, states, key, now);
    if (bundle) {
      displayedBundle = bundle;
      if (!state || state.serveToken !== bundle.serveToken || now - state.shownAt >= rotateMs) {
        state = { serveToken: bundle.serveToken, shownAt: now, counted: false, updatedAt: now };
      } else {
        state.updatedAt = now;
      }
      const viewMs = typeof bundle.minViewMs === 'number' ? bundle.minViewMs : minViewMs;
      const workInterval = workIntervalForDisplay(key, state, now);
      if (!state.counted && summary && bundle.ad.campaignType === 'PAID' && workInterval &&
          !fs.existsSync(PENDING_FILE) && workInterval.endedAt - workInterval.startedAt >= viewMs) {
        const event = {
          serveToken: bundle.serveToken,
          sequence: nextSequence(summary),
          machineId,
          startedAt: workInterval.startedAt,
          endedAt: workInterval.endedAt,
          clientVersion: CLIENT_VERSION,
          synced: false,
        };
        // 의도 파일은 append와 요약 갱신 사이의 강제 종료를 sync가 복구하게 한다.
        writeJsonAtomic(PENDING_FILE, { event, createdAt: now }, 0o600);
        fs.appendFileSync(LEDGER_FILE, JSON.stringify(event) + '\n');
        summary = appendEventSummary(summary, event, now);
        writeJsonAtomic(SUMMARY_FILE, summary, 0o600);
        writeJsonAtomic(SEQUENCE_FILE, { nextSequence: event.sequence }, 0o600);
        state.counted = true;
        try { fs.unlinkSync(PENDING_FILE); } catch {}
      }
      writeJsonAtomic(sessionFile(key), state, 0o600);
    }
  } finally {
    releaseLock(LEDGER_LOCK_FILE);
  }
} else {
  const current = readJson(sessionFile(key), null);
  if (validSessionState(current)) displayedBundle = valid.find((bundle) => bundle.serveToken === current.serveToken) || null;
}

if (!displayedBundle) emitAndExit(dim('clawad: 광고 준비 중 (다중 세션 토큰 대기)'));
emitAndExit(render(displayedBundle, summary || emptySummary(now)));
