#!/usr/bin/env node
// clawad — sync 데몬 (CLAW-24).
//
// 광고 표시 경로 밖에서 주기 실행한다. 하는 일:
//   1. 기기 등록(멱등)
//   2. 광고를 **표시하기 전에** serveToken 번들을 프리페치해 로컬 캐시에 채운다
//   3. 미전송 이벤트를 서버로 업로드한다 (사실만)
//
// 클라이언트는 금액을 계산·전송하지 않고, 멱등 키·HMAC을 만들지 않는다(CLAW-18).
// 토큰 발급·만료는 광고주 예산 예약/해제를 만들지 않는다(CLAW-23).
'use strict';
const fs = require('fs');
const path = require('path');
const { defaultDataDir, serverOrigin, userCommand, webOrigin } = require('./distribution-config');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || defaultDataDir();
const LEDGER_FILE = process.env.CLAWAD_LEDGER || path.join(DATA, 'ledger.jsonl');
const MACHINE_FILE = process.env.CLAWAD_MACHINE || path.join(DATA, 'machine.json');
const BUNDLES_FILE = process.env.CLAWAD_BUNDLES || path.join(DATA, 'bundles.json');
const AUTH_FILE = process.env.CLAWAD_AUTH || path.join(DATA, 'auth.json');
const LOCK_FILE = path.join(DATA, 'sync.lock');
const LEDGER_LOCK_FILE = path.join(DATA, 'ledger.lock');
// 손상 줄 격리 보관소 (CLAW-177). 원장 옆에 두어 CLAWAD_LEDGER를 옮겨도 따라간다.
const LEDGER_CORRUPT_FILE = `${LEDGER_FILE}.corrupt`;
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
const { dayKey, rebuildSummary } = require('./ledger-summary');
// 활동 상태 파일 정리 (CLAW-143). 훅이 만드는 이 파일들을 지우는 코드가 여기 말고는 없다.
const { purgeActivity } = require('./work-activity-store');
const { collectOverlayEvents, formatResult, writeTriggerPointer } = require('./overlay-events');

// 캐시가 통째로 곧 만료될 때 미리 리필하기 위한 지평. 정책에서만 온다(rules §5).
// 읽지 못하면 0으로 두어 기존 동작(서버 판단만 따름)을 유지한다.
let refillHorizonMs = 0;
try {
  refillHorizonMs = require('../policy/policy').loadPolicy().serveToken.refillHorizonMs;
} catch {}

const SUMMARY_FILE = path.join(DATA, 'ledger-summary.json');
const PENDING_FILE = path.join(DATA, 'ledger-summary-pending.json');
const REWARD_SUMMARY_FILE = path.join(DATA, 'reward-summary.json');
/**
 * 오버레이가 "광고를 다 소진했다" 안내를 띄울지 판단하는 신호 (CLAW-150, 계약 §2.3).
 * 오버레이가 정한 스키마이므로 형태를 바꾸지 않는다: { version, exhausted }.
 *
 * **일일 상한 도달일 때만 true다.** 재고가 빈 이유는 그 외에도 있지만(일시중지·킬스위치·
 * sync 미실행) 그때 "오늘 광고를 다 소진했어요"는 사실이 아니다. 안내 문구가 거짓이 되지
 * 않도록 의미를 상한으로 좁힌다.
 */
const AD_INVENTORY_FILE = path.join(DATA, 'ad-inventory.json');
const AD_INVENTORY_VERSION = 1;

function writeAdInventory(exhausted) {
  writeJsonAtomic(AD_INVENTORY_FILE, { version: AD_INVENTORY_VERSION, exhausted }, 0o600);
}
/**
 * 업로드 결과(인정 건수·거절 사유별 건수)를 하루 단위로 누적하는 진단 파일 (CLAW-164).
 * 서버 응답에 이미 들어 있던 값을 콘솔이 아니라 파일로 남긴다 — sync는 5분 주기 예약
 * 작업이라 stdout을 볼 방법이 없어서 "왜 적립이 안 늘지"를 추측으로만 다뤄야 했다.
 */
const EVENT_OUTCOMES_FILE = path.join(DATA, 'event-outcomes.json');
const EVENT_OUTCOMES_VERSION = 1;
/** 오버레이(별도 프로그램)가 읽는 정책 캐시. 오버레이는 정책 파일·코드에 접근하지 않는다 (CLAW-90). */
const OVERLAY_POLICY_FILE = path.join(DATA, 'overlay-policy.json');
const OVERLAY_POLICY_VERSION = 1;
const CAMPAIGN_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
// 전송 헤더의 방어 한계다. 실제 번들 수는 서버 serveToken 정책이 더 작게 제한한다.
const MAX_CACHED_CAMPAIGN_IDS = 64;

function readAuth() {
  let raw;
  try {
    raw = fs.readFileSync(AUTH_FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new SyncError('LOCAL_AUTH_MISSING', `로그인 정보가 없습니다. \`${userCommand('login')}\`을 실행하세요.`);
    }
    throw new SyncError('LOCAL_AUTH_INVALID', '로그인 정보를 읽을 수 없습니다. 다시 로그인하세요.');
  }
  try {
    const auth = JSON.parse(raw);
    if (!auth || typeof auth.accessToken !== 'string' || typeof auth.refreshToken !== 'string') throw new Error();
    return auth;
  } catch {
    throw new SyncError('LOCAL_AUTH_INVALID', `로그인 정보가 손상되었습니다. \`${userCommand('login')}\`으로 복구하세요.`);
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
  if (Date.now() < tokenExpiryMs(readAuth().accessToken) - 120000) return;

  // 회전은 1회성 refresh 토큰을 소비한다. login(liveSession)과 동시에 돌면 한쪽이 옛 토큰으로
  // 401을 맞으므로 auth 잠금으로 직렬화한다 (CLAW-275). 잠금을 못 얻으면 이전 동작대로 진행한다
  // — 드문 경합이 교착보다 낫고, 서버 401은 기존 SESSION_EXPIRED 경로가 받는다.
  const lockFile = `${AUTH_FILE}.lock`;
  const locked = acquireLockWithRetry(lockFile, { timeoutMs: 10000, retryMs: 50, staleMs: 60000 });
  try {
    // 잠금을 기다리는 동안 다른 프로세스가 회전을 끝냈을 수 있다 — 다시 읽고 다시 판정한다.
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
  } finally {
    if (locked) releaseLock(lockFile);
  }
}

function machineId() {
  return getMachineId(MACHINE_FILE);
}

/**
 * 보호된 엔드포인트의 401을 원인별로 구분한다. 처리방침·약관을 개정하면 서버가
 * CONSENT_REQUIRED를 던지는데(jwt-auth.guard), 이전에는 호출부마다 일반 Error를 던져
 * classifyError의 기본값 SYNC_FAILED로 뭉개졌다. 사용자는 적립이 멈춘 이유를 알 수 없었다.
 * 재로그인이 필요한 상태를 상태 파일에 남겨야 오버레이가 그것을 표시할 수 있다.
 */
async function assertAuthorized(res) {
  if (res.status !== 401 && res.status !== 403) return;
  const body = await res.clone().json().catch(() => ({}));
  if (body && body.error === 'CONSENT_REQUIRED') {
    throw new SyncError('CONSENT_REQUIRED', '약관·개인정보처리방침이 개정되어 재동의가 필요합니다. `clawad login`으로 다시 로그인하세요.');
  }
  if (res.status === 401) {
    throw new SyncError('SESSION_EXPIRED', '서버 세션이 만료되었거나 폐기되었습니다. `clawad login`으로 다시 로그인하세요.');
  }
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
  await assertAuthorized(res);
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
  for (const event of allEvents()) {
    if (typeof event.serveToken === 'string') tokens.add(event.serveToken);
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
 * 캐시가 곧 통째로 만료되는가. 토큰은 한 배치로 발급돼 만료도 동시에 오므로,
 * 개수만 보면 절벽 직전까지 충분해 보인다. 가장 이른 만료가 지평 안에 들면 미리 채운다(CLAW-107).
 */
function cacheExpiringSoon(bundles, now) {
  if (refillHorizonMs <= 0 || bundles.length === 0) return false;
  const earliest = Math.min(...bundles.map((bundle) => bundle.expiresAt));
  return earliest - now <= refillHorizonMs;
}

/**
 * 표시 전 프리페치. 남은 유효 토큰이 임계 이하이거나 캐시가 곧 만료될 때 리필한다.
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
  await assertAuthorized(statusRes);
  if (!statusRes.ok) throw new Error(`프리페치 상태 조회 실패: HTTP ${statusRes.status}`);
  const { unused, limit, needsRefill, paused, blockedCampaignIds, dailyCapReached, dailyCapResetsAt } =
    await statusRes.json();

  if (paused === true) {
    // 서버 전역/대상 중지는 fail-closed다. 광고 번들만 원자적으로 비우고, 로컬 append-only
    // 원장과 인증·리워드 캐시는 보존한다. 미전송 사실은 다음 sync에서도 계속 업로드한다.
    commitBundles([]);
    console.log('서버 광고 제공이 일시중지되어 로컬 광고 캐시를 비웠습니다.');
    return 0;
  }

  // 일일 상한은 계정 단위다(규칙 §4b). 도달하면 서버가 새 토큰을 안 주는데 이미 발급된 토큰은
  // TTL이 남아 있다. 그대로 두면 사용자는 적립이 0인 광고를 계속 보고 그 노출은 전부 거절된다
  // (CLAW-150). 남은 번들을 비우고 미사용 토큰도 폐기해 서버 예약을 함께 푼다.
  // 상한 도달은 정상 동작이므로 오류로 다루지 않는다. 정책일 경계(기본 한국시간 06:00, CLAW-151)를
  // 넘긴 뒤의 sync가 알아서 회복한다. 경계 시각은 서버가 dailyCapResetsAt으로 내려주며 여기서 계산하지 않는다.
  const capResetsAt = typeof dailyCapResetsAt === 'string' ? dailyCapResetsAt : '';
  if (dailyCapReached === true) {
    mergeRewardSummary({ dailyCapReached: true, dailyCapResetsAt: capResetsAt });
    writeAdInventory(true);
    if (bundles.length > 0) commitBundles([]);
    if (unused > 0) {
      const res = await fetch(`${SERVER}/v1/ad-decision/prefetched-tokens`, { method: 'DELETE', headers: headers(mid) });
      await assertAuthorized(res);
      // 폐기 실패는 치명적이지 않다. 토큰은 TTL로도 만료되고 이 호출은 멱등이라 다음 sync가 다시 시도한다.
      if (res.ok) {
        const { revoked } = await res.json();
        if (revoked > 0) console.log(`미사용 광고 토큰 ${revoked}건을 반납했습니다.`);
      }
    }
    console.log('오늘 적립 상한에 도달해 광고 표시를 멈췄습니다. 내일 다시 시작합니다.');
    return 0;
  }
  // 상한이 풀렸으면(정책일 롤오버) 표시용 상태도 함께 되돌린다.
  mergeRewardSummary({ dailyCapReached: false, dailyCapResetsAt: capResetsAt });
  writeAdInventory(false);

  // 캠페인 단위 중지는 다른 캠페인의 캐시까지 멈추지 않는다. 서버가 보낸 값 중 canonical
  // UUID만 사용하고, 해당 캠페인의 미사용 bundle만 원자 제거한다. 오버레이는 이 파일을 다시
  // 읽으므로 다음 렌더부터 차단 광고를 선택하지 않는다.
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
    await assertAuthorized(res);
    if (res.ok) {
      const { revoked } = await res.json();
      console.log(`로컬 캐시 유실 감지 — 미사용 토큰 ${revoked}건 폐기 후 재프리페치`);
    }
  } else if (!needsRefill && !cacheExpiringSoon(bundles, now)) {
    console.log(`프리페치 불필요 (미사용 ${unused}/${limit})`);
    return bundles.length;
  } else if (!needsRefill) {
    console.log(`캐시 임박 만료 감지 — 미리 리필합니다 (미사용 ${unused}/${limit})`);
  }

  let added = 0;
  // 상한까지만 채운다. 서버가 429로 막으면 멈춘다.
  for (let i = bundles.length; i < limit; i++) {
    const res = await fetch(`${SERVER}/v1/ad-decision`, { headers: decisionHeaders(mid) });
    await assertAuthorized(res);
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

/**
 * 원장 JSONL을 줄 단위로 읽는다 (CLAW-177).
 *
 * 파일 전체를 하나의 try/catch로 감싸면 손상된 한 줄이 전체를 빈 배열로 만들고,
 * 그 뒤 모든 sync가 "업로드할 것 없음"이 되어 적립이 조용히 멈춘다. 요약 재구축
 * (rebuildSummary)은 줄 단위 내성이 있어 status에는 노출이 그대로 보이므로 증상이 드러나지 않는다.
 *
 * 파싱 실패 줄은 버리지 않고 corrupt로 돌려보내, 원장을 재작성하는 쪽이 격리 보관하게 한다.
 */
function readLedger() {
  let raw;
  try {
    raw = fs.readFileSync(LEDGER_FILE, 'utf8').replace(/^﻿/, '');
  } catch {
    return { events: [], corrupt: [] };
  }
  const events = [];
  const corrupt = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      corrupt.push(line);
      continue;
    }
    // 객체가 아닌 JSON(숫자·문자열·배열)은 이벤트로 다루지 않는다.
    if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
    else corrupt.push(line);
  }
  return { events, corrupt };
}

function allEvents() {
  return readLedger().events;
}

/**
 * 손상 줄을 원장 옆 격리 파일로 옮긴다 (CLAW-177).
 * 원장 재작성은 파싱된 줄만 남기므로, 먼저 여기에 보관하지 않으면 그대로 사라진다.
 * 격리 실패가 업로드를 되돌리지 않는다 — 보관은 진단용이고 원장 진행이 우선이다.
 */
function quarantineCorruptLines(lines) {
  if (!lines.length) return;
  try {
    fs.mkdirSync(path.dirname(LEDGER_CORRUPT_FILE), { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(
      LEDGER_CORRUPT_FILE,
      `${lines.map((line) => `${stamp}\t${line}`).join('\n')}\n`,
      { mode: 0o600 },
    );
    console.log(`원장 손상 줄 ${lines.length}건을 ${path.basename(LEDGER_CORRUPT_FILE)}로 격리했습니다.`);
  } catch {}
}

function unsyncedEvents() {
  return allEvents().filter((e) => !e.synced);
}

// 대용량 원장 재구축은 수거 경로가 아닌 sync에서만 수행한다.
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
 * 오버레이가 읽을 정책 캐시를 갱신한다 (CLAW-90, overlay-contract §2).
 * 오버레이는 별도 프로그램이라 정책 파일·loadPolicy에 접근하지 않는다 — 표시에 필요한 값만
 * 여기서 캐시로 넘긴다. 단가·상한·배분율은 넘기지 않는다(클라이언트가 금액을 다루지 않는다).
 * 정책을 읽지 못하면 캐시를 쓰지 않는다 — 오버레이는 캐시가 없으면 광고 기능만 끄고 펫은 그대로 뜬다.
 */
function refreshOverlayPolicyCache() {
  let policy;
  try {
    policy = require('../policy/policy').loadPolicy();
  } catch {
    return false;
  }
  let rewardShopUrl = null;
  try {
    const configured = new URL(webOrigin());
    if (configured.protocol === 'https:') rewardShopUrl = configured.href;
  } catch {
    // 잘못된 선택 링크는 생략한다. 광고 정책 캐시 전체를 무효화하지 않는다.
  }
  const value = {
    version: OVERLAY_POLICY_VERSION,
    ...(rewardShopUrl ? { rewardShopUrl } : {}),
    overlay: {
      adRotateMs: policy.overlay.adRotateMs,
      // 인정 구간 사이 간격 (CLAW-135). 표시를 끊는 값이 아니라, 오버레이가 스풀에 남길
      // 인정 구간의 시작을 직전 구간 종료로부터 이만큼 미루게 하는 값이다.
      adGapMs: policy.overlay.adGapMs,
      idleThresholdMs: policy.overlay.idleThresholdMs,
      maxWidthPx: policy.overlay.maxWidthPx,
    },
    impression: { minViewMs: policy.impression.minViewMs },
    // 활동 상태의 유효기간 (CLAW-142). 훅이 Stop을 못 보낸 세션은 active=true로 굳는데,
    // 수거(overlay-events.js)는 이 값으로 그 구간을 닫아서 읽는다. 오버레이가 같은 값을
    // 쓰지 않으면 표시와 인정의 판단이 어긋나 "보이지만 인정되지 않는" 노출만 쌓인다.
    activity: { staleActiveMs: policy.activity.staleActiveMs },
  };
  const current = readJson(OVERLAY_POLICY_FILE, null);
  if (current && JSON.stringify({ ...current, updatedAt: undefined }) === JSON.stringify({ ...value, updatedAt: undefined })) {
    return false;
  }
  writeJsonAtomic(OVERLAY_POLICY_FILE, { ...value, updatedAt: Date.now() }, 0o600);
  return true;
}

/**
 * 오버레이 스풀을 수거해 이 실행에서 함께 업로드한다 (CLAW-90).
 * 오버레이의 즉시 트리거가 실패했거나 오버레이만 살아 있던 구간을 이 주기 실행이 메운다.
 * 수거 실패는 sync 전체를 멈추지 않는다 — 사유만 남기고 다음 주기에 다시 시도한다.
 */
function collectOverlaySpool() {
  try {
    writeTriggerPointer({ dataDir: DATA });
    const result = collectOverlayEvents({ dataDir: DATA });
    const touched = result.collected > 0 || result.purged > 0 || Object.keys(result.dropped).length > 0;
    if (result.skipped || touched) console.log(formatResult(result));
  } catch {
    console.log('오버레이 노출 이벤트 수거에 실패했습니다 — 다음 주기에 다시 시도합니다.');
  }
}

/**
 * 오래된 활동 상태 파일을 정리한다 (CLAW-143).
 * **반드시 수거 뒤에 부른다** — 방금 수거가 참조한 활성 구간을 먼저 지우면 안 된다.
 * 보유기간은 정책에서만 오고, 읽지 못하면 정리하지 않는다(기본값으로 넘겨짚지 않는다).
 */
function purgeWorkState() {
  try {
    const retentionMs = require('../policy/policy').loadPolicy().activity.workStateRetentionMs;
    const { removed } = purgeActivity(path.join(DATA, 'work-state'), Date.now(), retentionMs);
    if (removed > 0) console.log(`오래된 활동 상태 파일 ${removed}건을 정리했습니다.`);
  } catch {
    // 위생 작업이라 실패해도 sync를 멈추지 않는다. 다음 주기에 다시 시도한다.
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
    // 표시 시작 신호(CLAW-71). 레거시 원장 이벤트엔 없을 수 있어 값이 있을 때만 싣는다.
    ...(Number.isFinite(e.renderStarted) ? { renderStarted: e.renderStarted } : {}),
    clientVersion: e.clientVersion || CLIENT_VERSION,
  }));

  const res = await fetch(`${SERVER}/v1/events`, {
    method: 'POST',
    headers: headers(mid),
    body: JSON.stringify(payload),
  });
  await assertAuthorized(res);
  if (!res.ok) {
    // 서버 불통 시 이벤트를 로컬에 남겨두고 다음 실행에 재전송한다.
    console.log(`이벤트 업로드 보류 (HTTP ${res.status}) — 로컬에 보관하고 다음에 재전송합니다.`);
    return;
  }
  const result = await res.json();

  // 네트워크 요청 중 오버레이 이벤트 수거가 append한 이벤트를 덮어쓰지 않도록 최신 원장을
  // 공유 잠금 안에서 다시 읽고, 실제 업로드한 이벤트만 synced로 표시한다(CLAW-51).
  if (!acquireLockWithRetry(LEDGER_LOCK_FILE, { timeoutMs: 2000, retryMs: 20, staleMs: 5000 })) {
    throw new SyncError('LOCAL_LEDGER_BUSY', '로컬 이벤트 원장이 사용 중입니다. 다음 동기화에서 다시 시도합니다.');
  }
  try {
    const uploadedKeys = new Set(unsynced.map((e) => `${e.serveToken}:${e.machineId}:${e.sequence}`));
    const { events: latest, corrupt } = readLedger();
    // 아래 재작성은 파싱된 이벤트만으로 원장을 통째로 갈아끼운다. 여기서 빈 배열을 그대로
    // 쓰면 원장이 빈 파일이 되어 미전송 노출이 로컬에서 사라진다 (CLAW-177).
    // 첫 읽기에는 이벤트가 있었으므로(없으면 위에서 이미 반환) 0건은 그 사이 원장을
    // 읽지 못하게 된 상황이다. 이번 synced 표시를 건너뛰면 다음 실행에서 재전송되지만,
    // 서버 멱등 키가 중복 적립을 막으므로 재전송이 손실보다 안전하다.
    if (latest.length === 0) {
      console.log('원장을 읽지 못해 전송 표시를 건너뜁니다 — 다음 실행에서 재전송합니다.');
    } else {
      for (const event of latest) {
        if (uploadedKeys.has(`${event.serveToken}:${event.machineId}:${event.sequence}`)) event.synced = true;
      }
      // 재작성이 손상 줄을 지우기 전에 격리 파일로 먼저 옮긴다.
      quarantineCorruptLines(corrupt);
      fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
      const ledgerTemp = `${LEDGER_FILE}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(ledgerTemp, `${latest.map((e) => JSON.stringify(e)).join('\n')}\n`);
        fs.renameSync(ledgerTemp, LEDGER_FILE);
        rebuildSummary(LEDGER_FILE, SUMMARY_FILE);
        writeBundlesLocked(loadValidBundles(Date.now()));
        try { fs.unlinkSync(PENDING_FILE); } catch {}
      } finally {
        try { fs.unlinkSync(ledgerTemp); } catch {}
      }
    }
  } finally {
    releaseLock(LEDGER_LOCK_FILE);
  }

  recordEventOutcomes(result.accepted, result.rejected);
  const rejected = result.rejected ? JSON.stringify(result.rejected) : '{}';
  console.log(`이벤트 업로드: 전송 ${payload.length}건, 서버 인정 ${result.accepted ?? 0}건, 거절 ${rejected}`);
}

/**
 * 업로드 결과를 하루 단위로 누적한다 (CLAW-164). 날짜가 바뀌면 0에서 다시 센다.
 *
 * **진단·표시 전용이다.** 인정 여부와 금액은 전부 서버가 정한다 — 여기서는 서버가 이미
 * 내려준 건수를 그대로 더할 뿐이고, 이 파일로 어떤 판정도 하지 않는다 (규칙 §2 [CRITICAL]).
 * 기록 실패가 sync를 막지 않는다 — 진단용 부가 정보가 업로드를 되돌리면 안 된다.
 */
function recordEventOutcomes(accepted, rejected) {
  try {
    const today = dayKey();
    const current = readJson(EVENT_OUTCOMES_FILE, {}) || {};
    // 날짜가 다르거나 버전이 안 맞으면 이어 세지 않는다. 어제 수치가 오늘로 새면 진단이 틀어진다.
    const carry = current.version === EVENT_OUTCOMES_VERSION && current.day === today ? current : null;
    const totals = { ...(carry && carry.rejected && typeof carry.rejected === 'object' ? carry.rejected : {}) };
    if (rejected && typeof rejected === 'object') {
      for (const [reason, count] of Object.entries(rejected)) {
        if (Number.isInteger(count) && count > 0) totals[reason] = (totals[reason] || 0) + count;
      }
    }
    writeJsonAtomic(EVENT_OUTCOMES_FILE, {
      version: EVENT_OUTCOMES_VERSION,
      day: today,
      accepted: (carry && Number.isInteger(carry.accepted) ? carry.accepted : 0)
        + (Number.isInteger(accepted) ? accepted : 0),
      rejected: totals,
      updatedAt: Date.now(),
    }, 0o600);
  } catch {
    // 진단 기록은 실패해도 업로드 결과에 영향이 없다.
  }
}

/**
 * reward-summary.json을 병합 갱신한다. 오버레이가 읽는 표시용 파일이다(계약 §2).
 * 상한 상태는 prefetch-status에서, 포인트는 /v1/rewards에서 오므로 서로 다른 응답이 같은
 * 파일에 들어간다. 나중에 도는 쪽이 앞의 값을 지우지 않도록 읽고 합친다 (CLAW-150).
 */
function mergeRewardSummary(patch) {
  const current = readJson(REWARD_SUMMARY_FILE, {}) || {};
  writeJsonAtomic(REWARD_SUMMARY_FILE, {
    ...current,
    ...patch,
    version: 1,
    fetchedAt: Date.now(),
  }, 0o600);
}

async function refreshRewardSummary(mid) {
  const res = await fetch(`${SERVER}/v1/rewards`, { headers: headers(mid) });
  await assertAuthorized(res);
  if (!res.ok) return false;
  const value = await res.json();
  if (!value || !Number.isInteger(value.verifyingPoints) || value.verifyingPoints < 0 ||
      !Number.isInteger(value.confirmedPoints) || value.confirmedPoints < 0) return false;
  const patch = {
    verifyingPoints: value.verifyingPoints,
    confirmedPoints: value.confirmedPoints,
  };
  // 최소 교환 기준은 서버가 준다. 없으면(구 서버) 기존 값을 덮어쓰지 않는다 — 오버레이가
  // 기준을 추측하거나 하드코딩하지 않아야 한다 (규칙 §2·§5).
  if (Number.isInteger(value.minimumRedemptionPoints) && value.minimumRedemptionPoints >= 0) {
    patch.minimumRedemptionPoints = value.minimumRedemptionPoints;
  }
  // 캐리까지 담은 적립 총액(1/10 포인트 단위). 구 서버는 주지 않으므로 선택 항목이다 —
  // 없으면 기존 값을 덮어쓰지 않고, 오버레이는 정수 표시로 되돌아간다 (CLAW-157).
  // 클라이언트는 단가를 모르므로 이 값을 만들어내지 않는다 (규칙 §2).
  if (Number.isInteger(value.accruedPointsTenths) && value.accruedPointsTenths >= 0) {
    patch.accruedPointsTenths = value.accruedPointsTenths;
  }
  mergeRewardSummary(patch);
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
    console.log(`자동 sync가 일시중지되어 있습니다. \`${userCommand('resume')}\`으로 재개하세요.`);
    return;
  }
  if (!acquireLock(LOCK_FILE)) {
    console.log('다른 sync가 실행 중이므로 이번 실행을 건너뜁니다.');
    return;
  }

  const startedAt = new Date().toISOString();
  try {
    // 로컬 협약 파일은 인증과 무관하다 (overlay-contract §2·§3.3). 토큰 검사 뒤에 두면
    // **한 번도 로그인하지 않은 사용자에게는 영영 쓰이지 않는다** — 오버레이가 로그인 안내판도
    // 홈페이지 바로가기도 띄우지 못해, 로그인 진입점이 터미널 명령 하나만 남는다.
    refreshOverlayPolicyCache();
    writeTriggerPointer({ dataDir: DATA });
    await ensureFreshToken();
    const mid = machineId();
    rebuildLocalSummary();
    // 원장 복구 뒤에 수거한다 — pending이 남아 있으면 수거가 스스로 건너뛴다.
    collectOverlaySpool();
    // 수거가 끝난 뒤에 정리한다. 순서가 뒤바뀌면 방금 인정됐어야 할 노출의 근거를 지운다.
    purgeWorkState();
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
