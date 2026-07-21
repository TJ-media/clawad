'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = path.join(ROOT, 'deploy', 'production');
const OBSERVABILITY = path.join(DEPLOY, 'observability');
const PROMETHEUS_IMAGE = 'prom/prometheus:v3.10.0';
const ALERTMANAGER_IMAGE = 'prom/alertmanager:v0.32.1';

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/^\uFEFF/, '');
}

function requireMatch(value, pattern, message) {
  if (!pattern.test(value)) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(options.failureMessage || `${command} 검증이 실패했습니다.`);
}

function staticChecks() {
  const compose = read('deploy/production/compose.yml');
  const prometheus = read('deploy/production/observability/prometheus.yml');
  const alerts = read('deploy/production/observability/alerts.yml');
  const alertmanager = read('deploy/production/observability/alertmanager.yml');
  const caddy = read('deploy/production/Caddyfile');
  const dashboard = read('deploy/production/observability/grafana/dashboards/alpha-overview.json');

  for (const image of [PROMETHEUS_IMAGE, ALERTMANAGER_IMAGE, 'grafana/grafana:13.0.3', 'node:24.4.1-alpine']) {
    requireMatch(compose, new RegExp(image.replace(/[./]/g, '\\$&')), `${image} 고정 tag가 compose에 없습니다.`);
  }
  requireMatch(prometheus, /metrics_path:\s*\/monitor\/v1\/metrics/, 'Prometheus metrics path가 잘못되었습니다.');
  requireMatch(prometheus, /credentials_file:\s*\/run\/secrets\/monitoring_token/, 'Prometheus Bearer secret file이 없습니다.');
  // 수신기(Mattermost)는 Alertmanager 스키마를 400으로 거부하므로 alert-bridge가 변환한다 (CLAW-81).
  // Alertmanager는 내부 브리지로만 보내고, 실제 수신기 URL은 브리지가 시크릿으로 보유한다.
  requireMatch(alertmanager, /url:\s*http:\/\/alert-bridge:9099\/alert/, 'Alertmanager가 alert-bridge로 보내지 않습니다.');
  if (/url_file:|https?:\/\/(?!alert-bridge)/.test(alertmanager)) {
    throw new Error('Alertmanager 설정에 브리지 외 수신기 URL이 있습니다. 수신기 주소는 시크릿으로만 보유합니다.');
  }
  // depends_on 항목이 아니라 최상위 서비스 정의 블록을 집는다.
  const bridgeService = compose.split(/\r?\n {2}alert-bridge:\r?\n/)[1] || '';
  requireMatch(bridgeService, /secrets:\s*\[alert_webhook_url\]/, 'alert-bridge가 수신기 시크릿을 보유하지 않습니다.');
  requireMatch(bridgeService, /networks:\s*\[backend, edge\]/, 'alert-bridge가 송신용 edge에 연결되지 않았습니다.');
  requireMatch(caddy, /path \/monitor \/monitor\/\*/, 'Caddy가 공개 monitor 경로 전체를 차단하지 않습니다.');
  requireMatch(compose, /127\.0\.0\.1:\$\{GRAFANA_PORT:-3001\}:3000/, 'Grafana가 loopback에만 bind되지 않았습니다.');
  requireMatch(compose, /GF_AUTH_ANONYMOUS_ENABLED:\s*'false'/, 'Grafana anonymous access가 비활성화되지 않았습니다.');
  const prometheusService = compose.slice(compose.indexOf('  prometheus:'), compose.indexOf('  alertmanager:'));
  if (/depends_on:[\s\S]*api:\s*\{\s*condition:\s*service_healthy/.test(prometheusService)) {
    throw new Error('Prometheus가 unhealthy API 기동을 기다려 down alert를 놓칠 수 있습니다.');
  }
  const apiService = compose.slice(compose.indexOf('  api:'), compose.indexOf('  prometheus:'));
  const apiEnvironment = apiService.slice(apiService.indexOf('    environment:'), apiService.indexOf('    depends_on:'));
  if (/org\.opencontainers\.image\.revision/.test(apiService) || /^\s+RELEASE_SHA:\s/m.test(apiEnvironment)) {
    throw new Error('Compose가 API image에 구워진 release revision을 덮어쓰고 있습니다.');
  }
  requireMatch(alerts, /ClawadApiDown[\s\S]*ClawadEmergencyStopActive/, '필수 알림 규칙이 누락되었습니다.');
  // t4g.small 단일 호스트 자원 가드레일 (CLAW-76). node-exporter·cadvisor 기반 규칙이 있어야 한다.
  requireMatch(alerts, /ClawadHostMemoryLow[\s\S]*ClawadContainerRestarting/, 't4g 자원 가드레일 알림 규칙이 누락되었습니다.');
  requireMatch(prometheus, /job_name:\s*node-exporter[\s\S]*job_name:\s*cadvisor/, 'node-exporter·cadvisor scrape 대상이 누락되었습니다.');
  // 외부 백업 복제 감시 (CLAW-75).
  requireMatch(alerts, /ClawadBackupStale[\s\S]*ClawadBackupUploadUnverified/, '백업 복제 감시 알림 규칙이 누락되었습니다.');

  const parsed = JSON.parse(dashboard);
  if (parsed.uid !== 'clawad-alpha-overview' || !Array.isArray(parsed.panels) || parsed.panels.length < 10) {
    throw new Error('Grafana 알파 dashboard 구조가 유효하지 않습니다.');
  }
  const serialized = `${compose}\n${prometheus}\n${alerts}\n${alertmanager}\n${dashboard}`;
  for (const forbidden of [
    /Bearer[ \t]+[A-Za-z0-9._~-]{16,}/,
    /^[^$\r\n]*client_secret[ \t]*[:=][ \t]*(?!\$\{)[^ \t\r\n]+/im,
    /^[^$\r\n]*refresh_token[ \t]*[:=]/im,
  ]) {
    if (forbidden.test(serialized)) throw new Error('관측 설정에 비밀값으로 보이는 문자열이 있습니다.');
  }
}

function composeCheck() {
  const env = {
    RELEASE_SHA: '0123456789abcdef0123456789abcdef01234567',
    ROLLBACK_SHA: '89abcdef0123456789abcdef0123456789abcdef',
    DB_PASSWORD: 'compose-validation-database-secret',
    REDIS_PASSWORD: 'compose-validation-redis-secret',
    AUTH_JWT_SECRET: 'a'.repeat(32),
    SERVE_TOKEN_SECRET: 'b'.repeat(32),
    CLICK_TOKEN_SECRET: 'c'.repeat(32),
    ADMIN_JWT_SECRET: 'd'.repeat(32),
    SOCIAL_GOOGLE_CLIENT_ID: 'google-validation-id',
    SOCIAL_GOOGLE_CLIENT_SECRET: 'google-validation-secret',
    SOCIAL_KAKAO_CLIENT_ID: 'kakao-validation-id',
    SOCIAL_KAKAO_CLIENT_SECRET: 'kakao-validation-secret',
    SOCIAL_NAVER_CLIENT_ID: 'naver-validation-id',
    SOCIAL_NAVER_CLIENT_SECRET: 'naver-validation-secret',
    MONITORING_TOKEN_FILE: '/dev/null',
    ALERT_WEBHOOK_URL_FILE: '/dev/null',
    GRAFANA_ADMIN_PASSWORD_FILE: '/dev/null',
  };
  run('docker', ['compose', '--env-file', path.join(DEPLOY, '.env.example'), '-f', path.join(DEPLOY, 'compose.yml'), 'config', '--quiet'], {
    env,
    capture: true,
    failureMessage: 'docker compose 운영 구성 검증이 실패했습니다.',
  });
}

function containerChecks() {
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-observability-'));
  const monitorSecret = path.join(secretDir, 'monitoring-token');
  try {
    fs.writeFileSync(monitorSecret, 'configuration-validation-token-only\n', { mode: 0o600 });
    run('docker', [
      'run', '--rm', '--entrypoint', '/bin/promtool',
      '-v', `${OBSERVABILITY}:/etc/prometheus:ro`,
      '-v', `${monitorSecret}:/run/secrets/monitoring_token:ro`,
      PROMETHEUS_IMAGE, 'check', 'config', '/etc/prometheus/prometheus.yml',
    ], { failureMessage: 'promtool 구성 검증이 실패했습니다.' });
    run('docker', [
      'run', '--rm', '--entrypoint', '/bin/promtool',
      '-v', `${OBSERVABILITY}:/etc/prometheus:ro`,
      PROMETHEUS_IMAGE, 'test', 'rules', '/etc/prometheus/alerts.test.yml',
    ], { failureMessage: 'promtool 알림 규칙 동작 검증이 실패했습니다.' });
    // 수신기 URL은 alert-bridge가 보유하므로 alertmanager 구성 검증에는 시크릿이 필요 없다 (CLAW-81).
    run('docker', [
      'run', '--rm', '--entrypoint', '/bin/amtool',
      '-v', `${OBSERVABILITY}:/etc/alertmanager:ro`,
      ALERTMANAGER_IMAGE, 'check-config', '/etc/alertmanager/alertmanager.yml',
    ], { failureMessage: 'amtool 구성 검증이 실패했습니다.' });
  } finally {
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
}

try {
  staticChecks();
  composeCheck();
  if (process.argv.includes('--containers')) containerChecks();
  console.log(`운영 관측 구성 검증 완료${process.argv.includes('--containers') ? ' (promtool/amtool 포함)' : ''}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
