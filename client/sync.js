#!/usr/bin/env node
// clawad — 로컬 원장의 미전송 노출을 서버로 업로드하고 광고 인벤토리를 갱신한다.
// 핫패스(statusline.js) 밖에서 주기 실행 (수동 또는 스케줄러).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEDGER_FILE = process.env.CLAWAD_LEDGER || path.join(ROOT, 'data', 'ledger.jsonl');
const ADS_FILE = process.env.CLAWAD_ADS || path.join(ROOT, 'ads.json');
const SERVER = process.env.CLAWAD_SERVER || 'http://localhost:8787';

async function main() {
  let lines = [];
  try {
    lines = fs
      .readFileSync(LEDGER_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
  } catch {}

  const entries = lines.map((l) => JSON.parse(l));
  const unsynced = entries.filter((e) => !e.synced);

  if (unsynced.length) {
    const res = await fetch(`${SERVER}/impressions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(unsynced),
    });
    if (!res.ok) throw new Error(`업로드 실패: HTTP ${res.status}`);
    const result = await res.json();
    for (const e of unsynced) e.synced = true;
    fs.writeFileSync(LEDGER_FILE, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    console.log(`노출 업로드: 전송 ${result.received}건, 신규 인정 ${result.accepted}건`);
  } else {
    console.log('업로드할 노출 없음');
  }

  const adsRes = await fetch(`${SERVER}/ads`);
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
