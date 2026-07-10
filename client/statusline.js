#!/usr/bin/env node
// clawad — Claude Code statusLine 훅 (CLAW-24).
//
// 핫패스: 상태줄 갱신마다 호출된다.
//   - 네트워크 호출 금지. sync 데몬이 미리 채워둔 로컬 캐시만 읽는다.
//   - 출력은 정확히 한 줄. stdin이 비었거나 깨져도 반드시 한 줄 출력 후 exit 0.
//
// 보안 경계 (rules §2, CLAW-18):
//   - 금액·단가·배분율·유효 노출 여부를 계산·전송하지 않는다.
//   - 멱등 키·HMAC을 만들지 않는다. 서비스 비밀 키를 보유하지 않는다.
//   - 이벤트에는 사실만 담는다: serveToken, sequence, machineId, startedAt, endedAt, clientVersion.
//
// 프라이버시 (privacy-design.md §2):
//   - stdin 세션 JSON을 파싱만 하고 어떤 필드도 읽지 않는다. 프롬프트·경로·명령어에 접근하는 코드가 없다.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CLAWAD_DATA || path.join(ROOT, 'data');
const BUNDLES_FILE = process.env.CLAWAD_BUNDLES || path.join(DATA, 'bundles.json');
const STATE_FILE = path.join(DATA, 'state.json');
const LEDGER_FILE = path.join(DATA, 'ledger.jsonl');
const MACHINE_FILE = path.join(DATA, 'machine.json');
const PAUSE_FILE = path.join(DATA, 'paused');

const CLIENT_VERSION = require('../package.json').version;

// 표시용 추정 단가는 정책 설정에서 읽는다. 코드 하드코딩 금지(CLAW-12).
// 이 값은 "예상"일 뿐이며 확정 리워드는 서버가 검증 후 계산한다(CLAW-6).
let POINTS_PER_1000 = 0;
let MIN_VIEW_MS = 5000;
let ROTATE_MS = 15000;
try {
  const policy = require('../policy/policy').loadPolicy();
  POINTS_PER_1000 = policy.reward.rewardPerThousandAcceptedImpressions;
  MIN_VIEW_MS = policy.impression.minViewMs;
} catch {}

// 가명 머신 ID 생성·읽기는 sync와 공유한다 (client/machine.js).
const { getMachineId, readJson } = require('./machine');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s) => `\x1b[1;33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function emitAndExit(line) {
  console.log(line);
  process.exit(0);
}

// Claude Code가 stdin으로 세션 정보를 넘겨준다. 파싱 실패해도 동작해야 한다.
// 세션 필드를 읽지 않는다 — 수집 금지 목록(프롬프트·경로·명령어)에 구조적으로 접근하지 않기 위함.
try {
  fs.readFileSync(0, 'utf8');
} catch {}

if (fs.existsSync(PAUSE_FILE)) {
  emitAndExit(dim('clawad: 광고 일시중지됨 (npm run clawad:resume)'));
}

fs.mkdirSync(DATA, { recursive: true });
const now = Date.now();

// 머신 ID는 캐시가 비어 있어도 만들어 둔다. sync가 이 값으로 기기를 등록하고 번들을 받아온다
// — 조기 종료 전에 생성하지 않으면 신규 설치가 부트스트랩되지 않는다.
const machineId = getMachineId(MACHINE_FILE);

// 프리페치된 번들. 각 항목: { serveToken, expiresAt, ad, minViewMs }
const bundles = readJson(BUNDLES_FILE, []);
const valid = Array.isArray(bundles) ? bundles.filter((b) => b && b.expiresAt > now && b.ad) : [];

if (!valid.length) {
  // 서버 불통·캐시 소진 시에도 상태줄을 깨뜨리지 않는다.
  emitAndExit(dim('clawad: 광고 준비 중 (sync 대기)'));
}

let state = readJson(STATE_FILE, null);

// 로테이션: 현재 번들이 만료됐거나 표시 주기가 지나면 다음 번들로.
const currentIsValid = state && valid.some((b) => b.serveToken === state.serveToken);
if (!currentIsValid || now - state.shownAt >= ROTATE_MS) {
  const idx = state && currentIsValid ? (valid.findIndex((b) => b.serveToken === state.serveToken) + 1) % valid.length : 0;
  const next = valid[idx];
  state = {
    serveToken: next.serveToken,
    shownAt: now,
    counted: false,
    seq: (state && state.seq) || 0,
  };
}

const bundle = valid.find((b) => b.serveToken === state.serveToken) || valid[0];
const viewMs = typeof bundle.minViewMs === 'number' ? bundle.minViewMs : MIN_VIEW_MS;

// viewability: 같은 광고가 minViewMs 이상 연속 표시돼야 노출 1회. 이 기준을 우회하지 않는다.
if (!state.counted && now - state.shownAt >= viewMs) {
  state.counted = true;
  state.seq = (state.seq || 0) + 1;
  // 사실만 기록한다. 금액 필드 없음. 멱등 키는 서버가 serveToken의 jti로 생성한다(CLAW-18 §3).
  const event = {
    serveToken: bundle.serveToken,
    sequence: state.seq,
    machineId,
    startedAt: state.shownAt,
    endedAt: now,
    clientVersion: CLIENT_VERSION,
    synced: false,
  };
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(event) + '\n');
}
fs.writeFileSync(STATE_FILE, JSON.stringify(state));

// 예상 적립 (미검증 값). 확정 리워드는 서버 검증 후에만 정해진다.
// 화면에 원화를 표시하지 않는다 — 단위는 P(포인트).
let todayImp = 0;
let totalImp = 0;
const todayStr = new Date().toISOString().slice(0, 10);
try {
  for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      totalImp += 1;
      if (new Date(e.startedAt).toISOString().slice(0, 10) === todayStr) todayImp += 1;
    } catch {}
  }
} catch {}

const estPoints = (imp) => Math.floor((imp * POINTS_PER_1000) / 1000);
const fmt = (n) => n.toLocaleString('ko-KR');

// `[광고]` 표기는 시스템이 붙인다. 소재가 스스로 붙이지 못한다(CLAW-20).
emitAndExit(
  `${yellow('[광고]')} ${bundle.ad.text} ${dim('·')} ${cyan(bundle.ad.brand)} ${dim('│')} ` +
    `${green(`예상 오늘 ${fmt(estPoints(todayImp))}P`)} ${dim(`│ 누적 예상 ${fmt(estPoints(totalImp))}P`)}`
);
