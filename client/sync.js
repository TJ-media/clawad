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

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || path.join(ROOT, 'data');
const LEDGER_FILE = process.env.CLAWAD_LEDGER || path.join(DATA, 'ledger.jsonl');
const MACHINE_FILE = process.env.CLAWAD_MACHINE || path.join(DATA, 'machine.json');
const BUNDLES_FILE = process.env.CLAWAD_BUNDLES || path.join(DATA, 'bundles.json');
const AUTH_FILE = process.env.CLAWAD_AUTH || path.join(DATA, 'auth.json');
const SERVER = process.env.CLAWAD_SERVER || 'http://localhost:3000';
const CLIENT_VERSION = require('../package.json').version;

// 머신 ID 생성·읽기는 statusline과 공유한다. sync가 먼저 실행돼도 부트스트랩된다.
const { getMachineId, readJson } = require('./machine');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** 인증 토큰. 로그에 출력하지 않는다 (privacy-design.md §6.5). */
function accessToken() {
  const token = process.env.CLAWAD_ACCESS_TOKEN || (readJson(AUTH_FILE, {}) || {}).accessToken;
  if (!token) throw new Error('로그인이 필요합니다. CLAWAD_ACCESS_TOKEN 또는 data/auth.json을 설정하세요.');
  return token;
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
  return bundles.filter((b) => b && b.serveToken && b.expiresAt > now && b.ad);
}

/**
 * 표시 전 프리페치. 남은 유효 토큰이 임계 이하일 때만 리필한다.
 * 서버가 머신당 미사용 토큰 수를 제한하므로 429는 정상 종료 조건이다.
 */
async function prefetch(mid) {
  const now = Date.now();
  const bundles = loadValidBundles(now);

  const statusRes = await fetch(`${SERVER}/v1/ad-decision/prefetch-status`, { headers: headers(mid) });
  if (!statusRes.ok) throw new Error(`프리페치 상태 조회 실패: HTTP ${statusRes.status}`);
  const { unused, limit, needsRefill } = await statusRes.json();

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
    const res = await fetch(`${SERVER}/v1/ad-decision`, { headers: headers(mid) });
    if (res.status === 429) break; // PREFETCH_LIMIT_EXCEEDED
    if (res.status === 404) break; // NO_ELIGIBLE_AD
    if (!res.ok) throw new Error(`광고 결정 실패: HTTP ${res.status}`);
    const bundle = await res.json();
    bundles.push(bundle);
    added++;
  }

  writeJson(BUNDLES_FILE, bundles);
  console.log(`광고 번들 프리페치: +${added}건 (캐시 ${bundles.length}건)`);
  return bundles.length;
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

  // 서버가 수신을 확인한 이벤트만 synced로 표시한다. 재전송은 서버가 멱등 처리한다.
  for (const e of unsynced) e.synced = true;
  fs.writeFileSync(LEDGER_FILE, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));

  const rejected = result.rejected ? JSON.stringify(result.rejected) : '{}';
  console.log(`이벤트 업로드: 전송 ${payload.length}건, 서버 인정 ${result.accepted ?? 0}건, 거절 ${rejected}`);
}

/** 사용된 토큰의 번들을 캐시에서 제거한다. 만료 토큰도 함께 정리한다. */
function pruneUsedBundles() {
  const now = Date.now();
  const usedTokens = new Set(allEvents().map((e) => e.serveToken));
  const remaining = loadValidBundles(now).filter((b) => !usedTokens.has(b.serveToken));
  writeJson(BUNDLES_FILE, remaining);
  return remaining.length;
}

async function main() {
  const mid = machineId();
  await registerMachine(mid);
  await uploadEvents(mid);
  pruneUsedBundles();
  await prefetch(mid);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
