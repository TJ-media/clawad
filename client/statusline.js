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

const VIEW_MS = 5000; // 이 시간 이상 연속 표시돼야 노출 1회 (viewability)
const ROTATE_MS = 15000; // 광고 교체 주기
const GROSS_PER_IMP = 1.0; // 노출당 총 단가(원) = CPM 1,000원
const USER_SHARE = 0.5; // 개발자 배분율

function readJson(file, fallback) {
  try {
    // Windows 도구들이 BOM을 붙이는 경우가 있어 제거 후 파싱
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
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
let state = readJson(STATE_FILE, null);

if (!state || now - state.shownAt >= ROTATE_MS) {
  const idx = state ? (state.idx + 1) % ads.length : 0;
  state = { idx, adId: ads[idx].id, shownAt: now, counted: false };
}

const ad = ads[state.idx % ads.length];

if (!state.counted && now - state.shownAt >= VIEW_MS) {
  state.counted = true;
  const entry = {
    key: `${state.adId}:${state.shownAt}`, // 멱등 키: 같은 노출 슬롯은 서버에서 1회만 인정
    adId: state.adId,
    at: new Date().toISOString(),
    gross: GROSS_PER_IMP,
    user: GROSS_PER_IMP * USER_SHARE,
    session: session.session_id || null,
    synced: false,
  };
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n');
}
fs.writeFileSync(STATE_FILE, JSON.stringify(state));

// 수익 집계 (원장 전체 스캔 — 파일이 커지면 일별 롤업으로 교체)
let today = 0;
let total = 0;
const todayStr = new Date().toISOString().slice(0, 10);
try {
  for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      total += e.user;
      if (e.at.slice(0, 10) === todayStr) today += e.user;
    } catch {}
  }
} catch {}

const fmt = (n) => n.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s) => `\x1b[1;33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

console.log(
  `${yellow('[AD]')} ${ad.text} ${dim('·')} ${cyan(ad.brand)} ${dim('│')} ${green(`오늘 +${fmt(today)}원`)} ${dim(`│ 누적 ${fmt(total)}원`)}`
);
