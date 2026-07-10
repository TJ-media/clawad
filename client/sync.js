#!/usr/bin/env node
// clawad — 로컬 원장의 미전송 노출을 서버로 업로드하고 광고 인벤토리를 갱신한다.
// 핫패스(statusline.js) 밖에서 주기 실행 (수동 또는 스케줄러).
//
// 클라이언트는 사실만 전송한다(serveToken, sequence, machineId, startedAt, endedAt, userId, clientVersion).
// 금액·리워드·유효 노출 여부는 서버가 정책으로 판정한다. 클라이언트는 HMAC/비밀 키를 갖지 않는다.
//
// 참고: 운영에서는 노출을 "표시하기 전에" serveToken을 프리페치해 캐시한다(CLAW-24). 이 PoC는
// 데모를 위해 업로드 시점에 토큰을 받아 붙인다.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEDGER_FILE = process.env.CLAWAD_LEDGER || path.join(ROOT, 'data', 'ledger.jsonl');
const MACHINE_FILE = process.env.CLAWAD_MACHINE || path.join(ROOT, 'data', 'machine.json');
const ADS_FILE = process.env.CLAWAD_ADS || path.join(ROOT, 'ads.json');
const SERVER = process.env.CLAWAD_SERVER || 'http://localhost:8787';
const USER_ID = process.env.CLAWAD_USER_ID || 'local-user';
const CLIENT_VERSION = require('../package.json').version;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

async function main() {
  const machineId = (readJson(MACHINE_FILE, {}) || {}).machineId;
  if (!machineId) {
    console.log('머신 ID 없음 — statusline이 아직 노출을 기록하지 않았습니다.');
    return;
  }

  // 1) 기기 등록(멱등). 계정당 최대 기기 수 초과면 서버가 409로 알린다.
  const reg = await fetch(`${SERVER}/v1/machines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER_ID, machineId }),
  });
  if (reg.status === 409) {
    const e = await reg.json();
    console.log(`기기 등록 거부: ${e.error} — 기존 기기를 해제한 뒤 다시 시도하세요.`);
    return;
  }

  // 2) 미전송 노출 업로드.
  let lines = [];
  try {
    lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter((l) => l.trim());
  } catch {}
  const entries = lines.map((l) => JSON.parse(l));
  const unsynced = entries.filter((e) => !e.synced);

  let accepted = 0;
  for (const e of unsynced) {
    // 운영은 표시 전에 프리페치한 토큰을 쓴다. PoC는 업로드 시 토큰을 받는다.
    const dec = await fetch(`${SERVER}/v1/ad-decision?machineId=${encodeURIComponent(machineId)}`);
    if (!dec.ok) continue;
    const { serveToken } = await dec.json();
    const up = await fetch(`${SERVER}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          serveToken,
          sequence: e.sequence,
          machineId,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          userId: USER_ID,
          clientVersion: CLIENT_VERSION,
        },
      ]),
    });
    if (up.ok) {
      const r = await up.json();
      accepted += r.accepted || 0;
      e.synced = true;
    }
  }
  fs.writeFileSync(LEDGER_FILE, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  console.log(`노출 업로드: 미전송 ${unsynced.length}건 처리, 서버 인정 ${accepted}건`);

  // 3) 광고 인벤토리 갱신.
  const adsRes = await fetch(`${SERVER}/v1/ads`);
  if (adsRes.ok) {
    const ads = await adsRes.json();
    if (Array.isArray(ads) && ads.length) {
      fs.writeFileSync(ADS_FILE, JSON.stringify(ads, null, 2) + '\n');
      console.log(`광고 인벤토리 갱신: ${ads.length}건`);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
