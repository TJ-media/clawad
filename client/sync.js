#!/usr/bin/env node
// clawad — sync 데몬 (CLAW-24).
//
// 핫패스(statusline.js) 밖에서 주기 실행한다. 하는 일:
//   1. 기기 등록(멱등)
//   2. 광고를 **표시하기 전에** serveToken 번들을 프리페치해 로컬 캐시에 채운다
//   3. 미전송 이벤트를 서버로 업로드한다 (사실만)
//
// 클라이언트는 금액을 계산·전송하지 않고, 멱등 키·HMAC을 만들지 않는다(CLAW-18).
// 토큰 발급·만료는 광고주 예산 예약/해제를 만들지 않는다(CLAW-23).
'use strict';
const fs = require('fs');
const path = require('path');
const { defaultDataDir, serverOrigin } = require('./distribution-config');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const LEDGER_FILE = process.env.CLAWAD_LEDGER || path.join(DATA, 'ledger.jsonl');
const MACHINE_FILE = process.env.CLAWAD_MACHINE || path.join(DATA, 'machine.json');
const BUNDLES_FILE = process.env.CLAWAD_BUNDLES || path.join(DATA, 'bundles.json');
const AUTH_FILE = process.env.CLAWAD_AUTH || path.join(DATA, 'auth.json');
const LOCK_FILE = path.join(DATA, 'sync.lock');
const LEDGER_LOCK_FILE = path.join(DATA, 'ledger.lock');
const STATE_FILE = path.join(DATA, 'sync-state.json');
const PAUSE_FILE = path.join(DATA, 'paused');
const PREPARATION_FILE = path.join(DATA, 'preparation-state.json');
const SERVER = serverOrigin();
const CLIENT_VERSION = require('../package.json').version;
const REHEARSAL_MODE = process.env.CLAWAD_REHEARSAL_MODE || '';

// 머신 ID 생성·읽기는 statusline과 공유한다. sync가 먼저 실행돼도 부트스트랩된다.
const { getMachineId, readJson } = require('./machine');
const {
  SyncError,
  acquireLock,
  acquireLockWithRetry,
  classifyError,
  releaseLock,
  writeJsonAtomic,
} = require('./sync-runtime');
const { rebuildSummary } = require('./ledger-summary');

const SUMMARY_FILE = path.join(DATA, 'ledger-summary.json');
const PENDING_FILE = path.join(DATA, 'ledger-summary-pending.json');
const REWARD_SUMMARY_FILE = path.join(DATA, 'reward-summary.json');
const CAMPAIGN_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
// 전송 헤더의 방어 한계다. 실제 번들 수는 서버 serveToken 정책이 더 작게 제한한다.
const MAX_CACHED_CAMPAIGN_IDS = 64;

function readAuth() {
  let raw;
  try {
    raw = fs.readFileSync(AUTH_FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new SyncError('LOCAL_AUTH_MISSING', '로그인 정보가 없습니다. `npm run clawad:login`을 실행하세요.');
    }
    throw new SyncError('LOCAL_AUTH_INVALID', '로그인 정보를 읽을 수 없습니다. 다시 로그인하세요.');
  }
  try {
    const auth = JSON.parse(raw);
    if (!auth || typeof auth.accessToken !== 'string' || typeof auth.refreshToken !== 'string') throw new Error();
    return auth;
  } catch {
    throw new SyncError('LOCAL_AUTH_INVALID', '로그인 정보가 손상되었습니다. `npm run clawad:login`으로 복구하세요.');
  }
}

/** 인증 토큰. 로그에 출력하지 않는다 (privacy-design.md §6.5). */
function accessToken() {
  return process.env.CLAWAD_ACCESS_TOKEN || readAuth().accessToken;
}

/** access token(JWT)의 만료 시각(ms). 파싱 실패 시 0. */
function tokenExpiryMs(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * 만료 전 refresh 토큰 회전(CLAW-37). 회전은 즉시 data/auth.json에 반영한다.
 * 핫패스가 아닌 sync에서만 수행한다. env로 토큰을 주입한 경우(CI 등)는 건너뛴다.
 */
async function ensureFreshToken() {
  if (process.env.CLAWAD_ACCESS_TOKEN) return;
  const auth = readAuth();
  const exp = tokenExpiryMs(auth.accessToken);
  // 아직 2분 이상 여유가 있으면 회전하지 않는다.
  if (exp && Date.now() < exp - 120000) return;

  const res = await fetch(`${SERVER}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: auth.refreshToken }),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new SyncError('SESSION_EXPIRED', '서버 세션이 만료되었거나 폐기되었습니다. 다시 로그인하세요.');
    }
    throw new SyncError('SERVER_UNAVAILABLE', '서버가 세션 갱신을 처리하지 못했습니다. 다음 주기에 다시 시도합니다.');
  }
  const pair = await res.json();
  if (!pair || typeof pair.accessToken !== 'string' || typeof pair.refreshToken !== 'string') {
    throw new SyncError('SESSION_REFRESH_INVALID', '서버의 세션 갱신 응답이 올바르지 않습니다. 다음 주기에 다시 시도합니다.');
  }
  // 회전된 refresh 토큰은 1회성이므로 즉시 저장한다. 토큰 값은 로그에 남기지 않는다.
  writeJsonAtomic(AUTH_FILE, { ...auth, ...pair, refreshedAt: new Date().toISOString() }, 0o600);
}

function machineId() {
  return getMachineId(MACHINE_FILE);
}

function headers(mid) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken()}`,
    'x-clawad-machine-id': mid,
  };
}

function decisionHeaders(mid) {
  const value = headers(mid);
  if (REHEARSAL_MODE === 'TEST') value['x-clawad-rehearsal-mode'] = 'TEST';
  return value;
}

function selectedCampaignTypes() {
  if (!REHEARSAL_MODE) return new Set(['PAID', 'HOUSE']);
  if (REHEARSAL_MODE === 'TEST') return new Set(['TEST']);
  throw new SyncError('INVALID_REHEARSAL_MODE', '리허설 모드는 TEST만 허용됩니다. 설정을 확인하세요.');
}

async function registerMachine(mid) {
  const res = await fetch(`${SERVER}/v1/machines`, {
    method: 'POST',
    headers: headers(mid),
    body: JSON.stringify({ machineId: mid }),
  });
  if (res.status === 409) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`기기 등록 거부(${e.error || '한도 초과'}) — 기존 기기를 먼저 해제하세요.`);
  }
  if (res.status === 403) throw new Error('이 기기는 차단되었습니다.');
  if (!res.ok) throw new Error(`기기 등록 실패: HTTP ${res.status}`);
}

/** 유효한 캐시 번들만 남긴다. 만료·폐기 토큰은 재사용할 수 없다. */
function loadValidBundles(now) {
  const bundles = readJson(BUNDLES_FILE, []);
  if (!Array.isArray(bundles)) return [];
  const selected = selectedCampaignTypes();
  return bundles.filter(
    (b) => b && b.serveToken && b.expiresAt > now && b.ad && selected.has(b.ad.campaignType),
  );
}

function usedServeTokens() {
  const tokens = new Set();
  let raw;
  try { raw = fs.readFileSync(LEDGER_FILE, 'utf8').replace(/^\uFEFF/, ''); } catch { return tokens; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event.serveToken === 'string') tokens.add(event.serveToken);
    } catch {}
  }
  return tokens;
}

function writeBundlesLocked(bundles) {
  const usedTokens = usedServeTokens();
  const remaining = (Array.isArray(bundles) ? bundles : [])
    .filter((bundle) => bundle && !usedTokens.has(bundle.serveToken));
  writeJsonAtomic(BUNDLES_FILE, remaining, 0o600);
  return remaining;
}

function commitBundles(bundles) {
  if (!acquireLockWithRetry(LEDGER_LOCK_FILE, { timeoutMs: 2000, retryMs: 20, staleMs: 5000 })) {
    throw new SyncError('LOCAL_LEDGER_BUSY', '로컬 이벤트 원장이 사용 중입니다. 다음 동기화에서 다시 시도합니다.');
  }
  try {
    return writeBundlesLocked(bundles);
  } finally {
    releaseLock(LEDGER_LOCK_FILE);
  }
}

/**
 * 표시 전 프리페치. 남은 유효 토큰이 임계 이하일 때만 리필한다.
 * 서버가 머신당 미사용 토큰 수를 제한하므로 429는 정상 종료 조건이다.
 */
async function prefetch(mid) {
  const now = Date.now();
  const bundles = loadValidBundles(now);
  const cachedCampaignIds = [
    ...new Set(
      bundles
        .map((bundle) => bundle?.ad?.campaignId)
        .filter((campaignId) => typeof campaignId === 'string' && CAMPAIGN_ID_PATTERN.test(campaignId)),
    ),
  ].slice(0, MAX_CACHED_CAMPAIGN_IDS);
  const statusHeaders = headers(mid);
  if (cachedCampaignIds.length > 0) {
    statusHeaders['x-clawad-campaign-ids'] = cachedCampaignIds.join(',');
  }

  const statusRes = await fetch(`${SERVER}/v1/ad-decision/prefetch-status`, { headers: statusHeaders });
  if (!statusRes.ok) throw new Error(`프리페치 상태 조회 실패: HTTP ${statusRes.status}`);
  const { unused, limit, needsRefill, paused, blockedCampaignIds } = await statusRes.json();

  if (paused === true) {
    // 서버 전역/대상 중지는 fail-closed다. 광고 번들만 원자적으로 비우고, 로컬 append-only
    // 원장과 인증·리워드 캐시는 보존한다. 미전송 사실은 다음 sync에서도 계속 업로드한다.
    commitBundles([]);
    console.log('서버 광고 제공이 일시중지되어 로컬 광고 캐시를 비웠습니다.');
    return 0;
  }

  // 캠페인 단위 중지는 다른 캠페인의 캐시까지 멈추지 않는다. 서버가 보낸 값 중 canonical
  // UUID만 사용하고, 해당 캠페인의 미사용 bundle만 원자 제거한다. statusLine은 매 호출마다
  // 이 파일을 다시 읽으므로 다음 렌더부터 차단 광고를 선택하지 않는다.
  const blocked = new Set(
    Array.isArray(blockedCampaignIds)
      ? blockedCampaignIds.filter((id) => typeof id === 'string' && CAMPAIGN_ID_PATTERN.test(id))
      : [],
  );
  if (blocked.size > 0) {
    const kept = bundles.filter((bundle) => !blocked.has(bundle?.ad?.campaignId));
    const removed = bundles.length - kept.length;
    if (removed > 0) {
      bundles.splice(0, bundles.length, ...kept);
      const committed = commitBundles(bundles);
      bundles.splice(0, bundles.length, ...committed);
      console.log(`중지된 캠페인 광고 번들 ${removed}건을 로컬 캐시에서 제거했습니다.`);
    }
  }

  // 서버가 세는 미사용 토큰은 있는데 로컬 캐시가 비었다 = 캐시 유실.
  // 미동기화 이벤트 후보가 없을 때만 멱등 폐기하고 다시 받는다.
  if (unused > 0 && bundles.length === 0 && unsyncedEvents().length === 0) {
    const res = await fetch(`${SERVER}/v1/ad-decision/prefetched-tokens`, { method: 'DELETE', headers: headers(mid) });
    if (res.ok) {
      const { revoked } = await res.json();
      console.log(`로컬 캐시 유실 감지 — 미사용 토큰 ${revoked}건 폐기 후 재프리페치`);
    }
  } else if (!needsRefill) {
    console.log(`프리페치 불필요 (미사용 ${unused}/${limit})`);
    return bundles.length;
  }

  let added = 0;
  // 상한까지만 채운다. 서버가 429로 막으면 멈춘다.
  for (let i = bundles.length; i < limit; i++) {
    const res = await fetch(`${SERVER}/v1/ad-decision`, { headers: decisionHeaders(mid) });
    if (res.status === 429) break; // PREFETCH_LIMIT_EXCEEDED
    if (res.status === 404) break; // NO_ELIGIBLE_AD
    if (!res.ok) throw new Error(`광고 결정 실패: HTTP ${res.status}`);
    const bundle = await res.json();
    bundles.push(bundle);
    added++;
  }

  const committed = commitBundles(bundles);
  console.log(`광고 번들 프리페치: +${added}건 (캐시 ${committed.length}건)`);
  return committed.length;
}

function allEvents() {
  try {
    return fs
      .readFileSync(LEDGER_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function unsyncedEvents() {
  return allEvents().filter((e) => !e.synced);
}

// 대용량 원장 재구축은 statusLine이 아닌 sync에서만 수행한다.
function rebuildLocalSummary() {
  if (!acquireLockWithRetry(LEDGER_LOCK_FILE, { timeoutMs: 2000, retryMs: 20, staleMs: 5000 })) {
    throw new SyncError('LOCAL_LEDGER_BUSY', '로컬 이벤트 원장이 사용 중입니다. 다음 동기화에서 다시 시도합니다.');
  }
  try {
    const summary = rebuildSummary(LEDGER_FILE, SUMMARY_FILE);
    writeJsonAtomic(path.join(DATA, 'sequence.json'), { nextSequence: summary.nextSequence }, 0o600);
    // append 후 강제 종료된 토큰을 pending 해제 전에 원장 기준으로 캐시에서 제거한다.
    writeBundlesLocked(loadValidBundles(Date.now()));
    try { fs.unlinkSync(PENDING_FILE); } catch {}
    return summary;
  } finally {
    releaseLock(LEDGER_LOCK_FILE);
  }
}

/**
 * 사실만 전송한다. 금액 필드를 만들지 않는다.
 * 원장은 append-only이며, synced 플래그 갱신만 예외로 허용된다(rules §4).
 */
async function uploadEvents(mid) {
  const events = allEvents();
  const unsynced = events.filter((e) => !e.synced);
  if (!unsynced.length) {
    console.log('업로드할 이벤트 없음');
    return;
  }

  const payload = unsynced.map((e) => ({
    serveToken: e.serveToken,
    sequence: e.sequence,
    machineId: e.machineId,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    clientVersion: e.clientVersion || CLIENT_VERSION,
  }));

  const res = await fetch(`${SERVER}/v1/events`, {
    method: 'POST',
    headers: headers(mid),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // 서버 불통 시 이벤트를 로컬에 남겨두고 다음 실행에 재전송한다.
    console.log(`이벤트 업로드 보류 (HTTP ${res.status}) — 로컬에 보관하고 다음에 재전송합니다.`);
    return;
  }
  const result = await res.json();

  // 네트워크 요청 중 statusLine이 append한 이벤트를 덮어쓰지 않도록 최신 원장을
  // 공유 잠금 안에서 다시 읽고, 실제 업로드한 이벤트만 synced로 표시한다(CLAW-51).
  if (!acquireLockWithRetry(LEDGER_LOCK_FILE, { timeoutMs: 2000, retryMs: 20, staleMs: 5000 })) {
    throw new SyncError('LOCAL_LEDGER_BUSY', '로컬 이벤트 원장이 사용 중입니다. 다음 동기화에서 다시 시도합니다.');
  }
  try {
    const uploadedKeys = new Set(unsynced.map((e) => `${e.serveToken}:${e.machineId}:${e.sequence}`));
    const latest = allEvents();
    for (const event of latest) {
      if (uploadedKeys.has(`${event.serveToken}:${event.machineId}:${event.sequence}`)) event.synced = true;
    }
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    const ledgerTemp = `${LEDGER_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(ledgerTemp, latest.map((e) => JSON.stringify(e)).join('\n') + (latest.length ? '\n' : ''));
      fs.renameSync(ledgerTemp, LEDGER_FILE);
      rebuildSummary(LEDGER_FILE, SUMMARY_FILE);
      writeBundlesLocked(loadValidBundles(Date.now()));
      try { fs.unlinkSync(PENDING_FILE); } catch {}
    } finally {
      try { fs.unlinkSync(ledgerTemp); } catch {}
    }
  } finally {
    releaseLock(LEDGER_LOCK_FILE);
  }

  const rejected = result.rejected ? JSON.stringify(result.rejected) : '{}';
  console.log(`이벤트 업로드: 전송 ${payload.length}건, 서버 인정 ${result.accepted ?? 0}건, 거절 ${rejected}`);
}

async function refreshRewardSummary(mid) {
  const res = await fetch(`${SERVER}/v1/rewards`, { headers: headers(mid) });
  if (!res.ok) return false;
  const value = await res.json();
  if (!value || !Number.isInteger(value.verifyingPoints) || value.verifyingPoints < 0 ||
      !Number.isInteger(value.confirmedPoints) || value.confirmedPoints < 0) return false;
  writeJsonAtomic(REWARD_SUMMARY_FILE, {
    version: 1,
    verifyingPoints: value.verifyingPoints,
    confirmedPoints: value.confirmedPoints,
    fetchedAt: Date.now(),
  }, 0o600);
  return true;
}

/** 사용된 토큰의 번들을 캐시에서 제거한다. 만료 토큰도 함께 정리한다. */
function pruneUsedBundles() {
  const now = Date.now();
  const remaining = commitBundles(loadValidBundles(now));
  return remaining.length;
}

async function main() {
  if (fs.existsSync(PAUSE_FILE)) {
    try { fs.unlinkSync(PREPARATION_FILE); } catch {}
    console.log('자동 sync가 일시중지되어 있습니다. `npm run clawad:resume`으로 재개하세요.');
    return;
  }
  if (!acquireLock(LOCK_FILE)) {
    console.log('다른 sync가 실행 중이므로 이번 실행을 건너뜁니다.');
    return;
  }

  const startedAt = new Date().toISOString();
  try {
    await ensureFreshToken();
    const mid = machineId();
    rebuildLocalSummary();
    await registerMachine(mid);
    await uploadEvents(mid);
    await refreshRewardSummary(mid);
    pruneUsedBundles();
    await prefetch(mid);
    writeJsonAtomic(STATE_FILE, {
      lastRunAt: startedAt,
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (error) {
    const safe = classifyError(error);
    const previous = readJson(STATE_FILE, {}) || {};
    writeJsonAtomic(STATE_FILE, {
      lastRunAt: startedAt,
      lastSuccessAt: previous.lastSuccessAt || null,
      lastError: { ...safe, at: new Date().toISOString() },
    });
    throw new SyncError(safe.code, safe.message);
  } finally {
    releaseLock(LOCK_FILE);
    try { fs.unlinkSync(PREPARATION_FILE); } catch {}
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
