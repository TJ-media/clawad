#!/usr/bin/env node
// clawad — Claude Code statusLine 훅.
// 핫패스: 상태줄 갱신마다 호출되므로 네트워크 호출 금지, 로컬 파일만 사용.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// CLAWAD_* 환경변수는 테스트에서 데이터 경로를 격리할 때 사용
const DATA = process.env.CLAWAD_DATA || path.join(ROOT, 'data');
const ADS_FILE = process.env.CLAWAD_ADS || path.join(ROOT, 'ads.json');
const STATE_FILE = path.join(DATA, 'state.json');
const LEDGER_FILE = path.join(DATA, 'ledger.jsonl');
const MACHINE_FILE = path.join(DATA, 'machine.json');

const VIEW_MS = 5000; // 이 시간 이상 연속 표시돼야 노출 1회 (viewability)
const ROTATE_MS = 15000; // 광고 교체 주기

// 표시용 리워드 추정율(1,000회당 P)은 정책 설정에서 읽는다. 코드 하드코딩 금지(CLAW-12).
// 실제 확정 리워드는 서버가 계산한다. 여기 값은 "예상" 표시일 뿐이며, 정책 로드 실패 시 0.
// 클라이언트는 단가·배분율·리워드 금액·유효 노출 여부를 결정하지 않는다(CLAW-18 보안 경계).
let POINTS_PER_1000 = 0;
try {
  POINTS_PER_1000 = require('../policy/policy').loadPolicy().reward.rewardPerThousandAcceptedImpressions;
} catch {}

function readJson(file, fallback) {
  try {
    // Windows 도구들이 BOM을 붙이는 경우가 있어 제거 후 파싱
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

// 로컬 생성 가명 머신 ID. 하드웨어 식별자(MAC·시리얼·UUID)를 쓰지 않는다(CLAW-15).
function getMachineId() {
  const existing = readJson(MACHINE_FILE, null);
  if (existing && existing.machineId) return existing.machineId;
  const machineId = require('crypto').randomBytes(16).toString('hex');
  try {
    fs.writeFileSync(MACHINE_FILE, JSON.stringify({ machineId }));
  } catch {}
  return machineId;
}

// Claude Code가 stdin으로 세션 정보를 넘겨준다 (없어도 동작해야 함)
let session = {};
try {
  session = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
} catch {}

const ads = readJson(ADS_FILE, []);
if (!ads.length) {
  console.log('clawad: 광고 인벤토리 없음 (ads.json)');
  process.exit(0);
}

fs.mkdirSync(DATA, { recursive: true });
const now = Date.now();
const machineId = getMachineId();
let state = readJson(STATE_FILE, null);

if (!state || now - state.shownAt >= ROTATE_MS) {
  const idx = state ? (state.idx + 1) % ads.length : 0;
  state = { idx, adId: ads[idx].id, shownAt: now, counted: false, seq: (state && state.seq) || 0 };
}

const ad = ads[state.idx % ads.length];

if (!state.counted && now - state.shownAt >= VIEW_MS) {
  state.counted = true;
  state.seq = (state.seq || 0) + 1;
  // 사실만 기록한다. 금액은 넣지 않는다(서버가 정책으로 계산 — CLAW-18).
  // slotKey는 같은 슬롯의 중복 append를 막는 로컬 키다. 서버 멱등 키는 sync가 받은
  // serveToken의 jti로 서버가 생성한다(SHA-256(jti:machineId:sequence)).
  const entry = {
    slotKey: `${state.adId}:${state.shownAt}`,
    adId: state.adId,
    machineId,
    sequence: state.seq,
    startedAt: state.shownAt,
    endedAt: now,
    at: new Date().toISOString(),
    synced: false,
  };
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n');
}
fs.writeFileSync(STATE_FILE, JSON.stringify(state));

// 예상 적립 집계 (원장의 노출 건수 기반, 클라이언트 표시용 — 미검증 값).
// 실제 확정 리워드는 서버 검증(CLAW-6/18) 후에만 정해진다. 여기 값은 "예상"일 뿐이다.
// 화면에 원화를 표시하지 않는다(전자금융거래법 리스크 회피, CLAW-14). 단위는 P(포인트).
let todayImp = 0;
let totalImp = 0;
const todayStr = new Date().toISOString().slice(0, 10);
try {
  for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      totalImp += 1;
      if (e.at.slice(0, 10) === todayStr) todayImp += 1;
    } catch {}
  }
} catch {}

// 리워드 모델 B: 인정 노출 1,000회당 300P (서버 정책 값의 클라이언트측 추정치)
const estPoints = (imp) => Math.floor((imp * POINTS_PER_1000) / 1000);
const fmt = (n) => n.toLocaleString('ko-KR');
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s) => `\x1b[1;33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

console.log(
  `${yellow('[광고]')} ${ad.text} ${dim('·')} ${cyan(ad.brand)} ${dim('│')} ${green(`예상 오늘 ${fmt(estPoints(todayImp))}P`)} ${dim(`│ 누적 ${fmt(estPoints(totalImp))}P`)}`
);
