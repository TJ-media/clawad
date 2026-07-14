#!/usr/bin/env node
// clawad 광고 서버 PoC (신 모델, 의존성 없음 · node:http).
// 핵심 원칙(CLAW 최신 정책):
//  - 클라이언트는 사실만 보낸다(serveToken, sequence, machineId, startedAt, endedAt, clientVersion).
//    금액(gross/userShare/rewardAmount 등)은 보내도 무시한다. 리워드·과금은 서버가 정책으로 계산한다.
//  - 멱등 키는 서버가 생성한다: SHA-256(tokenJti:machineId:sequence). 클라이언트 HMAC 없음.
//  - 동일 사용자 계정의 여러 기기 동시 노출은 한 건만 인정한다(CONCURRENT_USER_IMPRESSION). 제재 아님.
//  - 한 계정 기기 최대 N대(정책값). 네 번째 등록은 409 MACHINE_LIMIT_EXCEEDED.
//  - 캠페인 유형 PAID/HOUSE/TEST에 따라 과금·리워드 자격을 강제한다.
//  - 모든 정책값(단가·상한·간격·수명)은 policy 모듈에서 로드한다. 코드 하드코딩 없음.
//
// 이 PoC는 파일 기반(재시작에도 유지)이며 단일 프로세스다. 운영은 PostgreSQL 트랜잭션과
// UNIQUE(token_jti, machine_id, sequence)·행 잠금으로 다중 인스턴스 동시성까지 보장한다(CLAW-6/17).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadPolicy, pointsForImpressions } = require('../policy/policy');
const { idempotencyKey } = require('./lib/idempotency');
const { issueServeToken, verifyServeToken } = require('./lib/serveToken');
const { decideConcurrent, CONCURRENT_REASON } = require('./lib/concurrentDedup');
const { canRegisterDevice } = require('./lib/deviceLimit');
const { eligibility } = require('./lib/campaign');

const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.CLAWAD_DATA_DIR || __dirname;
const ADS_FILE = process.env.CLAWAD_ADS || path.join(__dirname, 'ads.json');
const EVENTS_FILE = process.env.CLAWAD_EVENTS_FILE || path.join(DATA_DIR, 'events.jsonl');
const DEVICES_FILE = process.env.CLAWAD_DEVICES_FILE || path.join(DATA_DIR, 'devices.jsonl');
const TOKEN_SECRET = process.env.CLAWAD_TOKEN_SECRET || 'poc-dev-secret'; // 운영: 시크릿 매니저(CLAW-27)

const POLICY = loadPolicy();

function readJsonl(file) {
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
  } catch {}
  return out;
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

// 활성 기기 목록 = register 이벤트 중 이후 release 되지 않은 것.
function activeDevices(userId) {
  const active = new Map();
  for (const e of readJsonl(DEVICES_FILE)) {
    if (e.userId !== userId) continue;
    if (e.type === 'register') active.set(e.machineId, true);
    else if (e.type === 'release') active.delete(e.machineId);
  }
  return [...active.keys()];
}

function firstAd() {
  const ads = JSON.parse(fs.readFileSync(ADS_FILE, 'utf8').replace(/^﻿/, ''));
  return ads[0];
}

function policySnapshotFor(ad, campaignType) {
  const elig = eligibility({ type: campaignType, houseRewardOptIn: false });
  return {
    policyVersion: POLICY.version,
    rewardPolicyId: null,
    billingEligible: elig.billingEligible,
    rewardEligible: elig.rewardEligible,
    pricePerImpressionKrw: Math.floor(POLICY.advertiser.defaultCpmKrw / 1000),
    rewardPerThousandAcceptedImpressions: POLICY.reward.rewardPerThousandAcceptedImpressions,
    minViewMs: POLICY.impression.minViewMs,
    concurrentToleranceMs: POLICY.impression.concurrentToleranceMs,
    timeWindowToleranceMs: POLICY.impression.timeWindowToleranceMs,
    dailyAcceptedImpressionLimit: POLICY.reward.dailyAcceptedImpressionLimit,
    dailyRewardLimit: POLICY.reward.dailyRewardLimit,
    perCampaignDailyImpressionLimit: POLICY.frequency.perCampaignDailyImpressionLimit,
    advertiserDailyImpressionLimit: null,
  };
}

const routes = {
  // 광고 결정 + serveToken 발급 (프리페치). 운영은 노출 전에 미리 받아 캐시한다(CLAW-24).
  'GET /v1/ads': (req, res) => {
    try {
      return json(res, 200, JSON.parse(fs.readFileSync(ADS_FILE, 'utf8').replace(/^﻿/, '')));
    } catch {
      return json(res, 500, { error: 'ads.json 로드 실패' });
    }
  },

  'GET /v1/ad-decision': (req, res, url) => {
    const machineId = url.searchParams.get('machineId');
    const userId = url.searchParams.get('userId');
    if (!machineId || !userId) return json(res, 400, { error: 'userId, machineId 필요' });
    let ad;
    try {
      ad = firstAd();
    } catch {
      return json(res, 500, { error: 'ads.json 로드 실패' });
    }
    if (!ad) return json(res, 503, { error: '가용 광고 없음' });
    const campaignType = ad.campaignType || 'PAID';
    const policySnapshot = policySnapshotFor(ad, campaignType);
    const serveToken = issueServeToken(
      {
        campaignId: ad.id,
        creativeId: ad.creativeId || ad.id,
        userId,
        machineId,
        campaignType,
        policySnapshotId: `poc-policy-${policySnapshot.policyVersion}`,
        policySnapshot,
      },
      TOKEN_SECRET,
      POLICY.serveToken.ttlMs
    );
    return json(res, 200, {
      serveToken,
      ad: { campaignId: ad.id, text: ad.text, brand: ad.brand, label: '광고', campaignType },
      minViewMs: POLICY.impression.minViewMs,
    });
  },

  // 기기 등록 (계정당 최대 N대). 운영은 DB 트랜잭션 안에서 검사한다.
  'POST /v1/machines': async (req, res) => {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { error: 'JSON 필요' });
    }
    const { userId, machineId } = body;
    if (!userId || !machineId) return json(res, 400, { error: 'userId, machineId 필요' });
    const active = activeDevices(userId);
    if (active.includes(machineId)) return json(res, 200, { registered: true, devices: active.length });
    const gate = canRegisterDevice(active.length, POLICY.device.maxDevicesPerAccount);
    if (!gate.ok) return json(res, gate.status, { error: gate.code });
    appendJsonl(DEVICES_FILE, { type: 'register', userId, machineId, at: new Date().toISOString() });
    return json(res, 201, { registered: true, devices: active.length + 1 });
  },

  'POST /v1/machines/release': async (req, res) => {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { error: 'JSON 필요' });
    }
    const { userId, machineId } = body;
    if (!userId || !machineId) return json(res, 400, { error: 'userId, machineId 필요' });
    appendJsonl(DEVICES_FILE, { type: 'release', userId, machineId, at: new Date().toISOString() });
    return json(res, 200, { released: true, devices: activeDevices(userId).length });
  },

  // 노출 이벤트 수집. 사실만 받고 서버가 검증·계산한다.
  'POST /v1/events': async (req, res) => {
    let events;
    try {
      events = JSON.parse((await readBody(req)) || 'null');
      if (!Array.isArray(events)) throw new Error();
    } catch {
      return json(res, 400, { error: '배열 JSON 필요' });
    }

    // 기존 원장에서 멱등 키·사용자별 승인 노출을 복원(파일 기반, 재시작에도 유지).
    const existing = readJsonl(EVENTS_FILE);
    const seenIdem = new Map(); // idempotencyKey -> 이전 결과
    const acceptedByUser = new Map(); // userId -> [{startedAt, endedAt, impressionKey, confirmSeq}]
    let confirmCounter = 0;
    for (const e of existing) {
      confirmCounter++;
      if (e.idempotencyKey) seenIdem.set(e.idempotencyKey, e.decision);
      if (e.decision === 'ACCEPTED') {
        const arr = acceptedByUser.get(e.userId) || [];
        arr.push({ startedAt: e.startedAt, endedAt: e.endedAt, impressionKey: e.idempotencyKey, confirmSeq: e.confirmSeq });
        acceptedByUser.set(e.userId, arr);
      }
    }

    const rejected = {};
    let accepted = 0;
    const bumpReject = (reason) => (rejected[reason] = (rejected[reason] || 0) + 1);

    for (const ev of events) {
      // 클라이언트가 금액 필드를 실어보내도 무시한다(서버 권위). 사실 필드만 사용한다.
      const { serveToken, sequence, machineId, startedAt, endedAt, userId } = ev || {};
      if (!serveToken || !Number.isInteger(sequence) || !machineId || !userId) {
        bumpReject('BAD_REQUEST');
        continue;
      }
      const v = verifyServeToken(serveToken, TOKEN_SECRET);
      if (!v.ok) {
        bumpReject(v.reason); // BAD_TOKEN | EXPIRED
        continue;
      }
      if (v.payload.userId !== userId || v.payload.machineId !== machineId) {
        bumpReject('TOKEN_USER_MISMATCH');
        continue;
      }
      const idem = idempotencyKey(v.payload.jti, machineId, sequence);
      if (seenIdem.has(idem)) {
        // 멱등: 이전 처리 결과를 그대로 반영(중복 적립·중복 과금 없음).
        if (seenIdem.get(idem) === 'ACCEPTED') accepted++;
        else bumpReject('DUPLICATE');
        continue;
      }
      // viewability: 5초 이상 연속 표시.
      if (!(typeof startedAt === 'number' && typeof endedAt === 'number' && endedAt - startedAt >= v.payload.policySnapshot.minViewMs)) {
        const rec = baseRec(ev, v.payload, idem, 'REJECTED', 'BAD_INTERVAL', ++confirmCounter);
        appendJsonl(EVENTS_FILE, rec);
        seenIdem.set(idem, 'REJECTED');
        bumpReject('BAD_INTERVAL');
        continue;
      }
      // 동시 노출 dedup: 같은 userId의 승인 노출과 겹치면 한 건만 인정.
      const cand = { startedAt, endedAt, impressionKey: idem, confirmSeq: confirmCounter + 1 };
      const dec = decideConcurrent(cand, acceptedByUser.get(userId) || [], v.payload.policySnapshot.concurrentToleranceMs);
      if (dec.decision === 'REJECTED') {
        const rec = baseRec(ev, v.payload, idem, 'REJECTED', dec.reason, ++confirmCounter);
        appendJsonl(EVENTS_FILE, rec);
        seenIdem.set(idem, 'REJECTED');
        bumpReject(dec.reason);
        continue;
      }
      // 캠페인 유형별 자격.
      const rec = baseRec(ev, v.payload, idem, 'ACCEPTED', null, ++confirmCounter);
      rec.billed = v.payload.policySnapshot.billingEligible;
      rec.rewardEligible = v.payload.policySnapshot.rewardEligible;
      rec.testOnly = v.payload.campaignType === 'TEST';
      appendJsonl(EVENTS_FILE, rec);
      seenIdem.set(idem, 'ACCEPTED');
      const arr = acceptedByUser.get(userId) || [];
      arr.push({ startedAt, endedAt, impressionKey: idem, confirmSeq: cand.confirmSeq });
      acceptedByUser.set(userId, arr);
      accepted++;
    }

    return json(res, 200, { received: events.length, accepted, rejected });
  },

  // 집계. 유효 노출·리워드는 서버 계산. PAID/HOUSE/TEST 분리. 동시노출 거절은 유효 노출에 미포함.
  'GET /v1/stats': (req, res) => {
    const byType = { PAID: mkAgg(), HOUSE: mkAgg(), TEST: mkAgg() };
    const rejected = {};
    let received = 0;
    const acceptedCountByUser = {}; // rewardEligible 승인 노출 수 (리워드 계산용)
    for (const e of readJsonl(EVENTS_FILE)) {
      received++;
      const t = e.campaignType && byType[e.campaignType] ? e.campaignType : 'PAID';
      if (e.decision === 'ACCEPTED') {
        byType[t].validImpressions++;
        if (e.billed) byType[t].billedImpressions++;
        if (e.rewardEligible) {
          acceptedCountByUser[e.userId] = (acceptedCountByUser[e.userId] || 0) + 1;
        }
      } else if (e.reason) {
        rejected[e.reason] = (rejected[e.reason] || 0) + 1;
      }
    }
    // 리워드 포인트: 정책값으로 서버가 계산(사용자별 rewardEligible 승인 노출 → 포인트).
    let rewardPoints = 0;
    for (const uid of Object.keys(acceptedCountByUser)) {
      rewardPoints += pointsForImpressions(POLICY.reward, acceptedCountByUser[uid]);
    }
    return json(res, 200, { received, byType, rejected, rewardPoints });
  },
};

function mkAgg() {
  return { validImpressions: 0, billedImpressions: 0 };
}

function baseRec(ev, payload, idem, decision, reason, confirmSeq) {
  const rec = {
    idempotencyKey: idem,
    tokenJti: payload.jti,
    campaignId: payload.campaignId,
    campaignType: payload.campaignType,
    policySnapshotId: payload.policySnapshotId,
    policySnapshot: payload.policySnapshot,
    userId: ev.userId,
    machineId: ev.machineId,
    sequence: ev.sequence,
    startedAt: ev.startedAt,
    endedAt: ev.endedAt,
    clientVersion: ev.clientVersion || null,
    decision,
    confirmSeq,
    at: new Date().toISOString(),
  };
  if (reason) rec.reason = reason;
  return rec;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (handler) return handler(req, res, url);
  return json(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`clawad ad server: http://localhost:${PORT}`));
}

module.exports = { CONCURRENT_REASON };
