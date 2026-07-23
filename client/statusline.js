#!/usr/bin/env node
// clawad — Claude Code statusLine 훅 (CLAW-24, CLAW-51, CLAW-53).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { commandHint, defaultDataDir } = require('./distribution-config');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
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
const AUTH_FILE = process.env.CLAWAD_AUTH || path.join(DATA, 'auth.json');
const SYNC_STATE_FILE = path.join(DATA, 'sync-state.json');
const SYNC_LOCK_FILE = path.join(DATA, 'sync.lock');
const PREPARATION_FILE = path.join(DATA, 'preparation-state.json');
const REWARD_SUMMARY_FILE = path.join(DATA, 'reward-summary.json');
const CLIENT_VERSION = require('../package.json').version;
const FACT_CAMPAIGN_TYPES = new Set(['PAID', 'HOUSE', 'TEST']);
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const LEDGER_LOCK_WAIT_MS = 250;
const LEDGER_LOCK_STALE_MS = 5 * 1000;
/** 예상 적립 표시 증분. 표시 연출값이지 리워드 단가가 아니다 — 단가는 정책에서만 온다. */
const ESTIMATE_STEP_POINTS = 0.1;
/** 이 이상 벌어지면 연출을 포기하고 실제 값으로 즉시 맞춘다. 표시가 실적보다 뒤처지지 않게 한다. */
const ESTIMATE_EASE_MAX_GAP_POINTS = 1;

let pointsPerThousand = 0;
let minViewMs = 5000;
let rotateMs = 15000;
let staleActiveMs = 120000;
let rewardCacheStaleMs = 900000;
let dailyAcceptedImpressionLimit = 0;
try {
  const policy = require('../policy/policy').loadPolicy();
  pointsPerThousand = policy.reward.rewardPerThousandAcceptedImpressions;
  minViewMs = policy.impression.minViewMs;
  rotateMs = policy.statusLine.adRotateMs;
  staleActiveMs = policy.activity.staleActiveMs;
  rewardCacheStaleMs = policy.statusLine.rewardCacheStaleMs;
  dailyAcceptedImpressionLimit = policy.reward.dailyAcceptedImpressionLimit;
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

// 인정 노출로 소비된 번들은 캐시에서 사라지지만 화면에는 로테이션 주기를 채울 때까지 남아야 한다.
// 그 사이 렌더링에 쓸 최소 정보만 세션 상태에 복사해 둔다(광고 문구·브랜드·클릭 URL).
function displaySnapshot(bundle) {
  return { ad: bundle.ad, clickUrl: bundle.clickUrl };
}

function heldBundle(state) {
  return state && state.held && state.held.ad ? { serveToken: state.serveToken, ...state.held } : null;
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

// 로테이션은 adRotateMs를 그대로 지킨다. 인정 노출이 나도 표시 중인 광고는 주기를 채우고,
// 주기가 끝나면 직전과 다른 소재를 고른다. 같은 소재만 남았을 때만 어쩔 수 없이 반복한다.
function chooseBundle(valid, state, states, key, now) {
  const consumed = new Set([...states].filter(([, other]) => other.counted).map(([, other]) => other.serveToken));
  const held = heldBundle(state);
  const current = (state && valid.find((bundle) => bundle.serveToken === state.serveToken)) || held;
  // 이미 집계된 광고라도(consumed) 이 세션이 붙잡고 있는 동안에는 계속 보여준다.
  if (current && now - state.shownAt < rotateMs) return current;
  const owned = new Set([...states].filter(([otherKey]) => otherKey !== key).map(([, other]) => other.serveToken));
  const currentCreativeId = current && current.ad ? current.ad.creativeId : null;
  const start = current ? valid.findIndex((bundle) => bundle.serveToken === current.serveToken) + 1 : 0;
  const free = [];
  for (let offset = 0; offset < valid.length; offset += 1) {
    const candidate = valid[(start + offset) % valid.length];
    if (owned.has(candidate.serveToken) || consumed.has(candidate.serveToken)) continue;
    if (candidate.ad && candidate.ad.creativeId !== currentCreativeId) return candidate;
    free.push(candidate);
  }
  return free.length ? free[0] : null;
}

function loadValidBundles(now) {
  const bundles = readJson(BUNDLES_FILE, []);
  return Array.isArray(bundles) ? bundles.filter((bundle) => bundle && bundle.expiresAt > now && bundle.ad) : [];
}

function removeConsumedBundle(serveToken) {
  const bundles = readJson(BUNDLES_FILE, []);
  if (!Array.isArray(bundles)) return;
  const remaining = bundles.filter((bundle) => !bundle || bundle.serveToken !== serveToken);
  if (remaining.length !== bundles.length) writeJsonAtomic(BUNDLES_FILE, remaining, 0o600);
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

// 미전송분 추정(소수 유지): 아직 업로드되지 않은 인정 노출의 예상 적립.
function unsyncedEstimate(summary) {
  return ((summary.unsyncedImpressions || 0) * pointsPerThousand) / 1000;
}

// 표시용 누적 예상 적립 목표. 서버 확정·검증 중(정수)에 로컬 미전송분(소수)을 더한다.
// 세 구간은 서로소라 이중 계상이 없다. sync로 미전송분이 확정·검증으로 옮겨가도 합은 유지되고,
// 확정 전 1P 미만 캐리는 easeEstimate의 단조 래치가 보존한다 — 표시는 예상임을 명시한다(rules §2).
function accrualTarget(summary, rewards) {
  const confirmed = rewards ? rewards.confirmedPoints : 0;
  const verifying = rewards ? rewards.verifyingPoints : 0;
  return confirmed + verifying + unsyncedEstimate(summary);
}

// 누적 표시는 뒤로 가지 않는다. 목표가 낮아져도(sync 리셋·서버 반려) 이전 값을 유지하고, 오를 때만 0.1P씩 올린다.
function easeEstimate(previous, target) {
  const prior = Number.isFinite(previous) && previous > 0 ? previous : 0;
  if (target <= prior) return prior;
  // 오프라인 누적이나 최초 실행처럼 격차가 크면 연출 대상이 아니다. 즉시 실제 값으로 맞춘다.
  if (target - prior > ESTIMATE_EASE_MAX_GAP_POINTS) return target;
  return Math.min(target, Math.round((prior + ESTIMATE_STEP_POINTS) * 1000) / 1000);
}

function render(bundle, summary, estimatePoints) {
  const fmt = (value) => value.toLocaleString('ko-KR');
  const text = safeDisplayText(bundle.ad.text, 120);
  const brand = safeDisplayText(bundle.ad.brand, 60);
  const clickUrl = safeClickUrl(bundle.clickUrl);
  const adText = supportsHyperlinks() && clickUrl ? hyperlink(clickUrl, text) : text;
  const rewards = readRewardSummary();
  const shown = Number.isFinite(estimatePoints) ? estimatePoints : accrualTarget(summary, rewards);
  const estimatedPoints = Number.isInteger(shown) ? fmt(shown) : shown.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
  const estimated = `누적 예상 ${estimatedPoints}P`;
  const server = rewards ? `검증 중 ${fmt(rewards.verifyingPoints)}P · 확정 ${fmt(rewards.confirmedPoints)}P${rewards.stale ? ' (지연)' : ''}` : '확정 정보 대기';
  return `${yellow('[광고]')} ${adText} ${dim('·')} ${cyan(brand)} ${dim('·')} ${green(estimated)} ${dim(`· ${server}`)}`;
}

function readRewardSummary() {
  const value = readJson(REWARD_SUMMARY_FILE, null);
  if (!value || value.version !== 1 || !Number.isInteger(value.verifyingPoints) || !Number.isInteger(value.confirmedPoints) || !Number.isFinite(value.fetchedAt)) return null;
  return { ...value, stale: Date.now() - value.fetchedAt > rewardCacheStaleMs };
}

function preparationStatus() {
  if (!fs.existsSync(AUTH_FILE) && !process.env.CLAWAD_ACCESS_TOKEN) return `clawad: 로그인 필요 (${commandHint('login')})`;
  if (fs.existsSync(SYNC_LOCK_FILE) || readJson(PREPARATION_FILE, null)?.state === 'SYNCING') return 'clawad: 광고 동기화 중';
  const state = readJson(SYNC_STATE_FILE, null);
  if (state && state.lastError && ['NETWORK_UNAVAILABLE', 'SERVER_UNAVAILABLE'].includes(state.lastError.code)) {
    return 'clawad: 네트워크 복구 후 광고 재시도';
  }
  if (state && state.lastSuccessAt) return 'clawad: 현재 제공 가능한 광고 없음';
  return 'clawad: 광고 준비 중 (sync 대기)';
}

function safeDisplayText(value, maxLength) {
  return String(value || '')
    .replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength) || '광고';
}

function safeClickUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
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

// 대기 중 안내문. 숫자는 전부 정책값을 인용한다 — 코드에 고정하지 않는다(rules §5).
// 단가를 못 읽은 상태에서 "0P 적립"처럼 사실과 다른 문구를 내보내지 않도록 해당 항목은 제외한다.
function idleNotices() {
  const seconds = (ms) => String(Number((ms / 1000).toFixed(1)));
  return [
    'Claude Code가 작업 중일 때만 광고가 표시돼요',
    `광고는 ${seconds(rotateMs)}초마다 바뀌어요`,
    `같은 광고를 ${seconds(minViewMs)}초 이상 보면 인정 노출로 기록돼요`,
    pointsPerThousand > 0 ? `인정 노출 1,000회당 ${pointsPerThousand.toLocaleString('ko-KR')}P가 적립돼요` : null,
    '리워드는 비현금성이라 지정 상품 교환에만 쓸 수 있어요',
    '프롬프트·코드·파일 경로·터미널 명령어는 수집하지 않아요',
    `광고를 멈추려면 ${commandHint('pause')}`,
  ].filter(Boolean);
}

// 광고와 같은 주기로 돌린다. 시간 기반이라 상태 파일을 늘리지 않고 여러 세션이 같은 문구를 본다.
function noticeText(now) {
  const notices = idleNotices();
  return notices[Math.floor(now / rotateMs) % notices.length];
}

// 오늘 인정된 노출이 상한에 닿으면 더 봐도 적립되지 않는다. 광고를 계속 띄우지 않는다.
function dailyLimitReached(summary) {
  if (!summary || dailyAcceptedImpressionLimit <= 0) return false;
  const today = new Date().toISOString().slice(0, 10);
  return summary.today === today && (summary.todayImpressions || 0) >= dailyAcceptedImpressionLimit;
}

// 대기·상한 안내문에도 적립 현황을 붙인다. 광고 표시 때와 같은 누적 예상값(래치된 값이 있으면 그것)을 쓴다.
// 단가를 못 읽었거나 보여줄 적립이 없으면 "0P"처럼 사실과 다른 문구를 만들지 않도록 생략한다(idleNotices와 같은 기준).
function accrualSuffix(summary, estimate, now) {
  if (!(pointsPerThousand > 0)) return '';
  const rewards = readRewardSummary();
  const shown = Number.isFinite(estimate) ? estimate : accrualTarget(summary || emptySummary(now), rewards);
  const confirmed = rewards ? rewards.confirmedPoints : 0;
  if (shown <= 0 && confirmed <= 0) return '';
  const shownText = Number.isInteger(shown) ? shown.toLocaleString('ko-KR') : shown.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
  return ` · 누적 예상 ${shownText}P · 확정 ${confirmed.toLocaleString('ko-KR')}P`;
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
if (fs.existsSync(PAUSE_FILE)) emitAndExit(dim(`clawad: 광고 일시중지됨 (${commandHint('resume')})`));
fs.mkdirSync(DATA, { recursive: true });
const now = Date.now();
let machineId;
try { machineId = getMachineId(MACHINE_FILE); } catch { emitAndExit(dim('clawad: 로컬 상태 준비 중')); }
const valid = loadValidBundles(now);
if (!valid.length) emitAndExit(dim(preparationStatus()));

let summary = loadHotSummary(now);
if (!inputSessionId) emitAndExit(render(valid[0], summary || emptySummary(now)));

const key = sessionKey(inputSessionId);
let displayedBundle = null;
let estimatePoints;
if (acquireLockWithRetry(LEDGER_LOCK_FILE, { timeoutMs: LEDGER_LOCK_WAIT_MS, retryMs: 10, staleMs: LEDGER_LOCK_STALE_MS })) {
  try {
    fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
    const states = loadSessionStates(now);
    let state = states.get(key) || migrateLegacyState(key, now);
    if (state) states.set(key, state);
    // 잠금 대기 중 다른 세션이 소비한 번들을 다시 선택하지 않도록 캐시를 새로 읽는다.
    const lockedValid = loadValidBundles(now);
    const bundle = chooseBundle(lockedValid, state, states, key, now);
    if (bundle) {
      displayedBundle = bundle;
      if (!state || state.serveToken !== bundle.serveToken || now - state.shownAt >= rotateMs) {
        // 예상 적립은 광고가 아니라 세션에 누적된 값이다. 로테이션해도 이어서 올라가야 한다.
        const carried = state && Number.isFinite(state.shownEstimate) ? state.shownEstimate : undefined;
        state = { serveToken: bundle.serveToken, shownAt: now, counted: false, updatedAt: now, held: displaySnapshot(bundle), shownEstimate: carried };
      } else {
        state.updatedAt = now;
        if (!state.held) state.held = displaySnapshot(bundle);
      }
      const viewMs = typeof bundle.minViewMs === 'number' ? bundle.minViewMs : minViewMs;
      const workInterval = workIntervalForDisplay(key, state, now);
      if (!state.counted && summary && FACT_CAMPAIGN_TYPES.has(bundle.ad.campaignType) && workInterval &&
          !fs.existsSync(PENDING_FILE) && workInterval.endedAt - workInterval.startedAt >= viewMs) {
        const event = {
          serveToken: bundle.serveToken,
          sequence: nextSequence(summary),
          machineId,
          // 광고가 화면에 처음 뜬 시각(표시 시작). 활성 유효 구간 시작(startedAt) 이하다 (CLAW-71 퍼널 진단용).
          renderStarted: state.shownAt,
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
        // serveToken은 단일 사용이다. sync 성공 여부와 무관하게 로컬 후보에서 즉시 제거한다.
        let removed = false;
        try {
          removeConsumedBundle(bundle.serveToken);
          removed = true;
        } catch {}
        // 캐시 커밋 실패 시 pending을 남겨 sync가 원장 기준으로 복구하게 한다.
        if (removed) try { fs.unlinkSync(PENDING_FILE); } catch {}
      }
      // 표시용 누적 예상 적립을 한 단계 올린다. 잠금을 잡은 실행에서만 진행해 여러 세션이 같은 값을 공유한다.
      state.shownEstimate = easeEstimate(state.shownEstimate, accrualTarget(summary || emptySummary(now), readRewardSummary()));
      estimatePoints = state.shownEstimate;
      writeJsonAtomic(sessionFile(key), state, 0o600);
    }
  } finally {
    releaseLock(LEDGER_LOCK_FILE);
  }
} else {
  const current = readJson(sessionFile(key), null);
  if (validSessionState(current)) {
    displayedBundle = valid.find((bundle) => bundle.serveToken === current.serveToken) || heldBundle(current);
    estimatePoints = current.shownEstimate;
  }
}

// 일일 인정 노출 상한을 채우면 더 보여줘도 적립되지 않는다. 광고 대신 안내문으로 교체한다.
if (dailyLimitReached(summary)) emitAndExit(dim(`clawad: 오늘 적립 상한을 채웠어요 · ${noticeText(now)}${accrualSuffix(summary, estimatePoints, now)}`));
if (!displayedBundle) emitAndExit(dim('clawad: 광고 준비 중 (다중 세션 토큰 대기)'));
// 대기 중(Claude 응답 생성이 끝난 상태)에는 광고 대신 안내문을 표시한다.
// 집계 블록 뒤에 두어, 작업이 끝난 직후 실행에서 마지막 활성 구간으로 인정되는 노출을 잃지 않는다.
// 표시 판단에는 stale 보정을 쓰지 않는다. staleActiveMs는 훅이 끊긴 세션이 무한히 집계되는 것을 막는
// 장치일 뿐 "지금 작업 중인가"의 답이 아니어서, 그 값을 넘긴 긴 턴에서 광고가 사라져 버린다.
if (!loadActivity(WORK_STATE_DIR, key, now, Number.POSITIVE_INFINITY).active) emitAndExit(dim(`clawad: ${noticeText(now)}${accrualSuffix(summary, estimatePoints, now)}`));
emitAndExit(render(displayedBundle, summary || emptySummary(now), estimatePoints));
