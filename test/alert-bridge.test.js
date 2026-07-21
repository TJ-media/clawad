'use strict';
// Alertmanager → Mattermost 변환 브리지 스모크 (CLAW-81).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 모듈 로드 시점에 읽는 경로라 require 전에 지정한다.
const WEBHOOK_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-bridge-')), 'webhook');
process.env.ALERT_WEBHOOK_URL_FILE = WEBHOOK_FILE;
const { createServer, formatAlertText } = require('../deploy/production/alert-bridge/server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Mattermost 대역 수신기. 받은 본문과 응답 코드를 제어한다.
async function withStubReceiver(status, run) {
  const received = [];
  const stub = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({ body, contentType: request.headers['content-type'] });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  const stubPort = await listen(stub);
  fs.writeFileSync(WEBHOOK_FILE, `http://127.0.0.1:${stubPort}/hooks/test`);
  const bridge = createServer();
  const bridgePort = await listen(bridge);
  try {
    return await run({ bridgePort, received });
  } finally {
    stub.close();
    bridge.close();
  }
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    const request = http.request({
      host: '127.0.0.1', port, path: '/alert', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const FIRING = {
  status: 'firing',
  groupLabels: { alertname: 'ClawadApiDown' },
  alerts: [{
    status: 'firing',
    labels: { alertname: 'ClawadApiDown', severity: 'critical', component: 'api' },
    annotations: { summary: 'API가 응답하지 않습니다' },
    startsAt: '2026-07-21T04:40:00Z',
  }],
};

test('firing 알림을 Mattermost가 읽을 수 있는 텍스트로 변환한다', () => {
  const text = formatAlertText(FIRING);
  assert.match(text, /FIRING:1/);
  assert.match(text, /ClawadApiDown/);
  assert.match(text, /severity=critical/);
  assert.match(text, /API가 응답하지 않습니다/);
});

test('resolved 상태와 빈 알림도 안전하게 처리한다', () => {
  assert.match(formatAlertText({ status: 'resolved', alerts: [] }), /RESOLVED:0/);
  // 깨진 입력에도 예외를 던지지 않는다 (알림 경로가 죽으면 안 된다).
  for (const broken of [null, undefined, {}, { alerts: 'nope' }, { alerts: [null] }]) {
    assert.strictEqual(typeof formatAlertText(broken), 'string');
  }
});

test('허용목록 외 라벨은 수신기로 내보내지 않는다 (프라이버시)', () => {
  const text = formatAlertText({
    status: 'firing',
    alerts: [{
      labels: { alertname: 'X', severity: 'info', userId: 'u-123', machineId: 'm-abc', email: 'a@b.c' },
      annotations: { summary: 'ok', internalNote: '비공개' },
    }],
  });
  assert.doesNotMatch(text, /u-123|m-abc|a@b\.c|비공개/);
  assert.match(text, /severity=info/);
});

test('필드의 제어문자를 제거하고 알림당 길이를 제한한다', () => {
  const text = formatAlertText({
    status: 'firing',
    alerts: [{ labels: { alertname: 'A' }, annotations: { summary: 'x'.repeat(500) + '\u0000\u001b bad' } }],
  });
  // 헤더와 알림 줄을 잇는 구조적 개행(\u000a)은 허용하고, 필드에서 온 제어문자는 없어야 한다.
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f]/);
  assert.ok(text.length < 900);
});

test('정상 전달 시 Mattermost 형식({text})으로 보내고 204를 반환한다', async () => {
  await withStubReceiver(200, async ({ bridgePort, received }) => {
    const result = await post(bridgePort, JSON.stringify(FIRING));
    assert.strictEqual(result.status, 204);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].contentType, 'application/json');
    const forwarded = JSON.parse(received[0].body);
    assert.ok(typeof forwarded.text === 'string' && forwarded.text.includes('ClawadApiDown'));
    // Alertmanager 원본 스키마를 그대로 흘리지 않는다.
    assert.strictEqual(forwarded.alerts, undefined);
  });
});

test('수신기가 거부하면 502를 올려 Alertmanager가 재시도하게 한다', async () => {
  await withStubReceiver(400, async ({ bridgePort }) => {
    const result = await post(bridgePort, JSON.stringify(FIRING));
    assert.strictEqual(result.status, 502);
  });
});

test('깨진 JSON은 400으로 거절하고 크래시하지 않는다', async () => {
  await withStubReceiver(200, async ({ bridgePort, received }) => {
    const result = await post(bridgePort, '{not json');
    assert.strictEqual(result.status, 400);
    assert.strictEqual(received.length, 0);
  });
});

test('상한 초과 본문은 소켓을 끊지 않고 413으로 확정 거절한다 (무한 재시도 방지)', async () => {
  await withStubReceiver(200, async ({ bridgePort, received }) => {
    const huge = JSON.stringify({ status: 'firing', alerts: [], pad: 'x'.repeat(300 * 1024) });
    const result = await post(bridgePort, huge);
    assert.strictEqual(result.status, 413);
    assert.strictEqual(received.length, 0, '상한 초과 요청은 수신기로 전달하지 않는다');
  });
});

test('시크릿을 읽지 못하면 healthz가 503을 반환한다 (무증상 침묵 방지)', async () => {
  await withStubReceiver(200, async ({ bridgePort }) => {
    fs.unlinkSync(WEBHOOK_FILE);
    const result = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: bridgePort, path: '/healthz' }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      }).on('error', reject);
    });
    assert.strictEqual(result.status, 503);
    assert.match(result.text, /WEBHOOK_SECRET_UNAVAILABLE/);
  });
});

test('오류 응답은 JSON 형식이다', async () => {
  await withStubReceiver(200, async ({ bridgePort }) => {
    const result = await post(bridgePort, '{not json');
    assert.strictEqual(result.status, 400);
    assert.strictEqual(JSON.parse(result.text).code, 'INVALID_JSON');
  });
});

test('healthz는 200을 반환한다', async () => {
  await withStubReceiver(200, async ({ bridgePort }) => {
    const result = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: bridgePort, path: '/healthz' }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      }).on('error', reject);
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.text, 'ok');
  });
});
