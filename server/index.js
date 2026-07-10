#!/usr/bin/env node
// clawad 광고 서버 PoC — 의존성 없음 (node:http)
// GET /ads, POST /impressions (멱등), GET /stats
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
// CLAWAD_* 환경변수는 테스트에서 데이터 경로를 격리할 때 사용
const ADS_FILE = process.env.CLAWAD_ADS || path.join(__dirname, 'ads.json');
const IMP_FILE = process.env.CLAWAD_IMP_FILE || path.join(__dirname, 'impressions.jsonl');

function loadImpressionKeys() {
  const keys = new Set();
  try {
    for (const line of fs.readFileSync(IMP_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        keys.add(JSON.parse(line).key);
      } catch {}
    }
  } catch {}
  return keys;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ads') {
    try {
      return json(res, 200, JSON.parse(fs.readFileSync(ADS_FILE, 'utf8')));
    } catch {
      return json(res, 500, { error: 'ads.json 로드 실패' });
    }
  }

  if (req.method === 'POST' && req.url === '/impressions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let entries;
      try {
        entries = JSON.parse(body);
        if (!Array.isArray(entries)) throw new Error();
      } catch {
        return json(res, 400, { error: '배열 JSON 필요' });
      }
      const seen = loadImpressionKeys();
      let accepted = 0;
      for (const e of entries) {
        if (!e || typeof e.key !== 'string' || seen.has(e.key)) continue;
        seen.add(e.key);
        fs.appendFileSync(IMP_FILE, JSON.stringify(e) + '\n');
        accepted++;
      }
      return json(res, 200, { received: entries.length, accepted });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/stats') {
    const byAd = {};
    try {
      for (const line of fs.readFileSync(IMP_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          byAd[e.adId] = byAd[e.adId] || { impressions: 0, gross: 0, userShare: 0 };
          byAd[e.adId].impressions++;
          byAd[e.adId].gross += e.gross || 0;
          byAd[e.adId].userShare += e.user || 0;
        } catch {}
      }
    } catch {}
    return json(res, 200, byAd);
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`waitpay ad server: http://localhost:${PORT}`));
