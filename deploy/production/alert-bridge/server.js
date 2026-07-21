'use strict';
// Alertmanager → Mattermost 알림 변환 브리지 (CLAW-81).
//
// Alertmanager webhook은 자체 스키마({receiver,status,alerts:[...]})를 보내는데
// Mattermost 수신 웹훅은 {"text": ...}만 처리하고 그 외 페이로드는 400으로 거부한다.
// 웹훅 URL만 바꿔서는 알림이 전달되지 않으므로 이 브리지가 두 포맷을 잇는다.
//
// 규칙: Node 내장 모듈만 사용한다. Mattermost URL은 코드·로그에 남기지 않는다.
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.ALERT_BRIDGE_PORT || 9099);
const WEBHOOK_FILE = process.env.ALERT_WEBHOOK_URL_FILE || '/run/secrets/alert_webhook_url';
const MAX_BODY_BYTES = 256 * 1024;
const FORWARD_TIMEOUT_MS = Number(process.env.ALERT_BRIDGE_TIMEOUT_MS || 5000);

// 프라이버시(rules §6): Mattermost로 내보내는 라벨은 이 허용목록뿐이다.
// 임의 라벨을 그대로 흘리면 식별자가 섞여 나갈 수 있으므로 화이트리스트로만 통과시킨다.
const ALLOWED_LABELS = ['alertname', 'severity', 'component', 'service', 'provider', 'dependency', 'job'];
const ALLOWED_ANNOTATIONS = ['summary', 'description'];

// 제어문자를 제거하고 길이를 제한한다. 수신기로 원문을 그대로 싣지 않는다.
function clean(value, maxLength = 300) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function pick(source, allowed) {
  const result = [];
  if (!source || typeof source !== 'object') return result;
  for (const key of allowed) {
    const value = clean(source[key]);
    if (value) result.push([key, value]);
  }
  return result;
}

// Alertmanager 페이로드를 Mattermost가 이해하는 한 덩어리 텍스트로 변환한다.
function formatAlertText(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];
  const status = clean(body.status, 20).toUpperCase() || 'UNKNOWN';
  const icon = status === 'FIRING' ? '[발생]' : status === 'RESOLVED' ? '[해소]' : '[알림]';
  const groupName = pick(body.groupLabels, ALLOWED_LABELS).map(([, value]) => value).join(' ');
  const header = `**${icon} ${status}:${alerts.length}** ${groupName || '클로애드 운영 알림'}`;

  const lines = alerts.slice(0, 10).map((alert) => {
    const labels = pick(alert && alert.labels, ALLOWED_LABELS);
    const named = labels.find(([key]) => key === 'alertname');
    const name = named ? named[1] : '알림';
    const meta = labels.filter(([key]) => key !== 'alertname').map(([key, value]) => `${key}=${value}`).join(' ');
    const annotations = pick(alert && alert.annotations, ALLOWED_ANNOTATIONS).map(([, value]) => value).join(' — ');
    const startedAt = clean(alert && alert.startsAt, 40);
    const parts = [`• **${name}**`];
    if (meta) parts.push(`\`${meta}\``);
    if (annotations) parts.push(`— ${annotations}`);
    if (startedAt) parts.push(`(시작 ${startedAt})`);
    return parts.join(' ');
  });

  if (alerts.length > 10) lines.push(`• 외 ${alerts.length - 10}건`);
  return [header, ...lines].join('\n');
}

function readWebhookUrl() {
  const raw = fs.readFileSync(WEBHOOK_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('지원하지 않는 webhook 프로토콜');
  return url;
}

// 수신기로 전달한다. 실패하면 Alertmanager가 재시도하도록 오류를 그대로 올린다.
function forward(url, text) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ text }), 'utf8');
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
      timeout: FORWARD_TIMEOUT_MS,
    }, (response) => {
      let received = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (received.length < 2048) received += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: received }));
    });
    request.on('timeout', () => request.destroy(new Error('수신기 전송 시간 초과')));
    request.on('error', reject);
    request.end(payload);
  });
}

// 본문이 상한을 넘으면 소켓을 끊지 않고 남은 데이터를 버린 뒤 알린다.
// 끊어버리면 이미 destroy된 응답에 쓰다가 미처리 오류가 나고, 5xx로 답하면
// 항상 실패할 요청을 Alertmanager가 무한 재시도한다.
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve({ tooLarge, text: Buffer.concat(chunks).toString('utf8') }));
    request.on('error', reject);
  });
}

function respond(response, status, code) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code }));
}

function createServer() {
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      // 시크릿을 읽지 못하면 healthy로 보이면 안 된다. 알림 경로의 무증상 침묵을 막는다.
      try {
        readWebhookUrl();
      } catch {
        respond(response, 503, 'WEBHOOK_SECRET_UNAVAILABLE');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }
    if (request.method !== 'POST') {
      respond(response, 405, 'METHOD_NOT_ALLOWED');
      return;
    }
    try {
      const body = await readBody(request);
      // 상한 초과는 재시도해도 결과가 같으므로 4xx로 확정 거절한다.
      if (body.tooLarge) {
        respond(response, 413, 'PAYLOAD_TOO_LARGE');
        return;
      }
      let parsed;
      try { parsed = JSON.parse(body.text.replace(/^\uFEFF/, '')); } catch { parsed = null; }
      if (!parsed) {
        respond(response, 400, 'INVALID_JSON');
        return;
      }
      const result = await forward(readWebhookUrl(), formatAlertText(parsed));
      if (result.status >= 200 && result.status < 300) {
        // 성공 로그에 URL·본문을 남기지 않는다.
        console.log(`[alert-bridge] 전달 성공 status=${result.status}`);
        response.writeHead(204);
        response.end();
        return;
      }
      // 수신기가 거부하면 Alertmanager가 재시도하도록 5xx로 올린다.
      console.error(`[alert-bridge] 수신기 거부 status=${result.status}`);
      respond(response, 502, 'RECEIVER_REJECTED');
    } catch (error) {
      console.error(`[alert-bridge] 전달 실패: ${error && error.message ? error.message : error}`);
      respond(response, 502, 'FORWARD_FAILED');
    }
  });
}

if (require.main === module) {
  // 시크릿이 없거나 형식이 틀리면 조용히 뜨지 말고 기동을 거부한다(fail-closed).
  try {
    readWebhookUrl();
  } catch (error) {
    console.error(`[alert-bridge] 수신기 시크릿을 읽을 수 없어 기동을 중단합니다: ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
  createServer().listen(PORT, () => console.log(`[alert-bridge] listening on ${PORT}`));
}

module.exports = { createServer, formatAlertText };
