#!/usr/bin/env node
// clawad — Claude Code statusLine 훅 (CLAW-24, CLAW-51).
//
// 핫패스에서는 네트워크를 호출하지 않고, sync가 미리 채운 광고 번들만 읽는다.
// session_id는 로컬 해시 키로만 사용하며 원문·해시 모두 서버나 원장에 보내지 않는다.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || path.join(ROOT, 'data');
const BUNDLES_FILE = process.env.CLAWAD_BUNDLES || path.join(DATA, 'bundles.json');
const LEGACY_STATE_FILE = path.join(DATA, 'state.json');
const SESSION_STATE_DIR = path.join(DATA, 'session-state');
const SEQUENCE_FILE = path.join(DATA, 'sequence.json');
const LEDGER_FILE = path.join(DATA, 'ledger.jsonl');
const LEDGER_LOCK_FILE = path.join(DATA, 'ledger.lock');
const MACHINE_FILE = path.join(DATA, 'machine.json');
const PAUSE_FILE = path.join(DATA, 'paused');

const CLIENT_VERSION = require('../package.json').version;
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const LEDGER_LOCK_WAIT_MS = 250;
const LEDGER_LOCK_STALE_MS = 5 * 1000;

let POINTS_PER_1000 = 0;
let MIN_VIEW_MS = 5000;
const ROTATE_MS = 15000;
try {
  const policy = require('../policy/policy').loadPolicy();
  POINTS_PER_1000 = policy.reward.rewardPerThousandAcceptedImpressions;
  MIN_VIEW_MS = policy.impression.minViewMs;
} catch {}

const { getMachineId, readJson } = require('./machine');
const { acquireLockWithRetry, releaseLock, writeJsonAtomic } = require('./sync-runtime');

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
    if (/[\u0000-\u001f\u007f]/.test(sessionId)) return null;
    return sessionId;
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
  return Boolean(
    value &&
    typeof value.serveToken === 'string' &&
    Number.isFinite(value.shownAt) &&
    typeof value.counted === 'boolean' &&
    Number.isFinite(value.updatedAt)
  );
}

function readLedger() {
  const events = [];
  try {
    for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  return events;
}

function maxLedgerSequence(events) {
  return events.reduce((max, event) => Number.isInteger(event.sequence) ? Math.max(max, event.sequence) : max, 0);
}

function readNextSequence(events) {
  const stored = readJson(SEQUENCE_FILE, null);
  const ledgerMax = maxLedgerSequence(events);
  if (stored && Number.isInteger(stored.nextSequence) && stored.nextSequence >= ledgerMax) return stored.nextSequence;
  return ledgerMax;
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
  const migrated = {
    serveToken: legacy.serveToken,
    shownAt: legacy.shownAt,
    counted: Boolean(legacy.counted),
    updatedAt: now,
  };
  writeJsonAtomic(sessionFile(key), migrated, 0o600);
  if (Number.isInteger(legacy.seq) && legacy.seq >= 0) {
    writeJsonAtomic(SEQUENCE_FILE, { nextSequence: legacy.seq }, 0o600);
  }
  try { fs.unlinkSync(LEGACY_STATE_FILE); } catch {}
  return migrated;
}

function chooseBundle(valid, state, states, key, now) {
  const currentIsValid = state && valid.some((bundle) => bundle.serveToken === state.serveToken);
  if (currentIsValid && now - state.shownAt < ROTATE_MS) {
    return valid.find((bundle) => bundle.serveToken === state.serveToken);
  }

  const owned = new Set();
  for (const [otherKey, other] of states) {
    if (otherKey !== key) owned.add(other.serveToken);
  }
  const start = currentIsValid ? valid.findIndex((bundle) => bundle.serveToken === state.serveToken) + 1 : 0;
  for (let offset = 0; offset < valid.length; offset += 1) {
    const candidate = valid[(start + offset) % valid.length];
    if (!owned.has(candidate.serveToken)) return candidate;
  }
  return currentIsValid ? valid.find((bundle) => bundle.serveToken === state.serveToken) : null;
}

function render(bundle, todayImp, totalImp) {
  const estPoints = (impressions) => Math.floor((impressions * POINTS_PER_1000) / 1000);
  const fmt = (value) => value.toLocaleString('ko-KR');
  return (
    `${yellow('[광고]')} ${bundle.ad.text} ${dim('·')} ${cyan(bundle.ad.brand)} ${dim('│')} ` +
    `${green(`예상 오늘 ${fmt(estPoints(todayImp))}P`)} ${dim(`· 누적 예상 ${fmt(estPoints(totalImp))}P`)}`
  );
}

const inputSessionId = readSessionId();
if (fs.existsSync(PAUSE_FILE)) emitAndExit(dim('clawad: 광고 일시중지됨 (npm run clawad:resume)'));

fs.mkdirSync(DATA, { recursive: true });
const now = Date.now();
let machineId;
try {
  machineId = getMachineId(MACHINE_FILE);
} catch {
  emitAndExit(dim('clawad: 로컬 상태 준비 중'));
}
const bundles = readJson(BUNDLES_FILE, []);
const valid = Array.isArray(bundles) ? bundles.filter((bundle) => bundle && bundle.expiresAt > now && bundle.ad) : [];
if (!valid.length) emitAndExit(dim('clawad: 광고 준비 중 (sync 대기)'));

// session_id가 없거나 손상되면 광고만 표시하고 시간·원장은 갱신하지 않는다.
if (!inputSessionId) {
  const events = readLedger();
  const today = new Date().toISOString().slice(0, 10);
  const todayImp = events.filter((event) => {
    try { return new Date(event.startedAt).toISOString().slice(0, 10) === today; } catch { return false; }
  }).length;
  emitAndExit(render(valid[0], todayImp, events.length));
}

const key = sessionKey(inputSessionId);
let displayedBundle = null;
if (acquireLockWithRetry(LEDGER_LOCK_FILE, {
  timeoutMs: LEDGER_LOCK_WAIT_MS,
  retryMs: 10,
  staleMs: LEDGER_LOCK_STALE_MS,
})) {
  try {
    fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
    const states = loadSessionStates(now);
    let state = states.get(key) || migrateLegacyState(key, now);
    if (state) states.set(key, state);

    const bundle = chooseBundle(valid, state, states, key, now);
    if (bundle) {
      displayedBundle = bundle;
      if (!state || state.serveToken !== bundle.serveToken || now - state.shownAt >= ROTATE_MS) {
        state = { serveToken: bundle.serveToken, shownAt: now, counted: false, updatedAt: now };
      } else {
        state.updatedAt = now;
      }

      const viewMs = typeof bundle.minViewMs === 'number' ? bundle.minViewMs : MIN_VIEW_MS;
      if (!state.counted && now - state.shownAt >= viewMs) {
        const events = readLedger();
        const existing = events.find((event) => event.serveToken === bundle.serveToken && event.machineId === machineId);
        if (existing) {
          state.counted = true;
          writeJsonAtomic(SEQUENCE_FILE, { nextSequence: Math.max(readNextSequence(events), existing.sequence || 0) }, 0o600);
        } else {
          const nextSequence = readNextSequence(events) + 1;
          const event = {
            serveToken: bundle.serveToken,
            sequence: nextSequence,
            machineId,
            startedAt: state.shownAt,
            endedAt: now,
            clientVersion: CLIENT_VERSION,
            synced: false,
          };
          fs.appendFileSync(LEDGER_FILE, JSON.stringify(event) + '\n');
          writeJsonAtomic(SEQUENCE_FILE, { nextSequence }, 0o600);
          state.counted = true;
        }
      }
      writeJsonAtomic(sessionFile(key), state, 0o600);
    }
  } finally {
    releaseLock(LEDGER_LOCK_FILE);
  }
} else {
  const current = readJson(sessionFile(key), null);
  if (validSessionState(current)) {
    displayedBundle = valid.find((bundle) => bundle.serveToken === current.serveToken) || null;
  }
}

if (!displayedBundle) emitAndExit(dim('clawad: 광고 준비 중 (다중 세션 토큰 대기)'));
const events = readLedger();
const today = new Date().toISOString().slice(0, 10);
let todayImp = 0;
for (const event of events) {
  try {
    if (new Date(event.startedAt).toISOString().slice(0, 10) === today) todayImp += 1;
  } catch {}
}
emitAndExit(render(displayedBundle, todayImp, events.length));
