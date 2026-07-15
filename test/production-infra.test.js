'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('운영 compose는 DB·Redis를 비공개 영속 서비스로 구성한다', () => {
  const compose = read('deploy/production/compose.yml');
  assert.match(compose, /postgres-data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /redis-data:\/data/);
  assert.match(compose, /--appendfsync always/);
  assert.match(compose, /--requirepass/);
  assert.match(compose, /backend:\s*\n\s*internal: true/);
  assert.doesNotMatch(compose, /postgres:\s*\n(?: {4}.*\n)* {4}ports:/);
  assert.doesNotMatch(compose, /redis:\s*\n(?: {4}.*\n)* {4}ports:/);
});

test('운영 경계는 HTTPS, 준비 상태와 격리 복구를 제공한다', () => {
  const compose = read('deploy/production/compose.yml');
  assert.match(compose, /'443:443'/);
  assert.match(compose, /health\/ready/);
  assert.match(compose, /postgres-restore:[\s\S]*?tmpfs:/);
  assert.match(read('deploy/production/Caddyfile'), /reverse_proxy api:3000/);
  assert.match(read('docs/operations/production-deployment.md'), /down -v/);
});

test('user-web은 API와 같은 release로 배포되고 HTTPS 경계에서 검증된다', () => {
  const compose = read('deploy/production/compose.yml');
  const edge = read('deploy/production/Caddyfile');
  const webDockerfile = read('apps/user-web/Dockerfile');
  assert.match(compose, /clawad-user-web:\$\{RELEASE_SHA:\?RELEASE_SHA is required\}/);
  assert.match(compose, /user-web:[\s\S]*healthcheck:[\s\S]*\/healthz/);
  assert.match(edge, /\{\$WEB_DOMAIN\}[\s\S]*reverse_proxy @api api:3000[\s\S]*reverse_proxy user-web:8080/);
  assert.match(edge, /http:\/\/:8081[\s\S]*respond \/healthz 200/);
  const edgeService = compose.slice(compose.indexOf('  caddy:'), compose.indexOf('  postgres-restore:'));
  assert.match(edgeService, /healthcheck:[\s\S]*127\.0\.0\.1:8081\/healthz/);
  assert.match(webDockerfile, /org\.opencontainers\.image\.revision/);
  assert.match(webDockerfile, /deploy\/production\/Caddyfile/);
  assert.doesNotMatch(webDockerfile, /docs\/legal/);
  assert.match(compose, /LEGAL_PUBLIC_DIR:\?LEGAL_PUBLIC_DIR is required\}:\/srv\/legal:ro/);
  assert.doesNotMatch(compose, /\.\/Caddyfile:\/etc\/caddy\/Caddyfile/);
  assert.match(read('apps/user-web/Caddyfile'), /Content-Security-Policy/);
  assert.match(read('apps/user-web/Caddyfile'), /Cache-Control "no-store"/);
  const release = read('scripts/production-release.js');
  assert.match(release, /inspectLiveService\('user-web'\)/);
  assert.match(release, /inspectLiveService\('caddy'\)/);
  assert.match(release, /build', 'api', 'user-web'/);
  assert.match(release, /inspectReleaseImages/);
  assert.match(read('scripts/production-smoke.js'), /x-clawad-release/);
  assert.match(read('scripts/production-smoke.js'), /content-security-policy/);
  assert.match(read('scripts/production-smoke.js'), /외부 공개 금지/);
});

test('TEST 리허설 게이트는 운영 API에 기본 false로 전달된다', () => {
  const compose = read('deploy/production/compose.yml');
  assert.match(compose, /CLAWAD_TEST_REHEARSAL_ENABLED: \$\{CLAWAD_TEST_REHEARSAL_ENABLED:-false\}/);
  assert.match(compose, /CLAWAD_TEST_REHEARSAL_USER_IDS: \$\{CLAWAD_TEST_REHEARSAL_USER_IDS:-\}/);
});

test('운영 API 이미지는 비루트 사용자와 production 실행을 사용한다', () => {
  const dockerfile = read('apps/api/Dockerfile');
  assert.match(dockerfile, /ARG NODE_IMAGE=node:24\.4\.1-alpine/);
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS (?:build|runtime)/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /NODE_ENV=production/);
  assert.match(dockerfile, /ai\.clawad\.emergency-stop-compatible=true/);
  assert.match(dockerfile, /apps\/api\/node_modules/);
  assert.match(dockerfile, /server\/lib/);
});

test('운영 관측 stack은 내부 metrics와 loopback dashboard만 노출한다', () => {
  const compose = read('deploy/production/compose.yml');
  assert.match(compose, /prom\/prometheus:v3\.10\.0/);
  assert.match(compose, /prom\/alertmanager:v0\.32\.1/);
  assert.match(compose, /grafana\/grafana:13\.0\.3/);
  assert.match(compose, /127\.0\.0\.1:\$\{GRAFANA_PORT:-3001\}:3000/);
  assert.match(compose, /MONITORING_TOKEN_FILE: \/run\/secrets\/monitoring_token/);
  assert.match(compose, /ALERT_WEBHOOK_URL_FILE/);
  const prometheusService = compose.slice(compose.indexOf('  prometheus:'), compose.indexOf('  alertmanager:'));
  assert.doesNotMatch(prometheusService, /api:\s*\{\s*condition:\s*service_healthy/);
  assert.match(read('deploy/production/Caddyfile'), /path \/monitor \/monitor\/\*/);
  assert.match(read('deploy/production/observability/prometheus.yml'), /credentials_file: \/run\/secrets\/monitoring_token/);
  assert.match(read('deploy/production/observability/alertmanager.yml'), /url_file: \/run\/secrets\/alert_webhook_url/);
  const alerts = read('deploy/production/observability/alerts.yml');
  assert.match(alerts, /ClawadOAuthFailureRate[\s\S]*increase\(clawad_oauth_events_total[\s\S]*\[10m\]\)/);
  assert.doesNotMatch(alerts, /delta\(clawad_oauth_events_total/);
  assert.match(alerts, /ClawadAdDecisionHighLatency/);
  assert.match(alerts, /ClawadObservabilityQueryFailed/);
  assert.match(alerts, /ClawadEmergencyStopActive/);
  const dashboard = JSON.parse(read('deploy/production/observability/grafana/dashboards/alpha-overview.json'));
  assert.equal(dashboard.uid, 'clawad-alpha-overview');
});

test('운영 release는 불변 commit SHA와 명시적 rollback을 요구한다', () => {
  const compose = read('deploy/production/compose.yml');
  const dockerfile = read('apps/api/Dockerfile');
  assert.match(compose, /clawad-api:\$\{RELEASE_SHA:\?RELEASE_SHA is required\}/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/);
  assert.doesNotMatch(compose, /org\.opencontainers\.image\.revision/);
  const apiService = compose.slice(compose.indexOf('  api:'), compose.indexOf('  prometheus:'));
  const apiEnvironment = apiService.slice(apiService.indexOf('    environment:'), apiService.indexOf('    depends_on:'));
  assert.doesNotMatch(apiEnvironment, /^\s+RELEASE_SHA:\s/m);
  assert.match(compose, /ai\.clawad\.rollback-revision/);
  const release = read('scripts/production-release.js');
  assert.match(release, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(release, /status.*--porcelain.*--untracked-files=normal/s);
  assert.match(release, /production-backup\.js/);
  assert.match(release, /ai\.clawad\.emergency-stop-compatible/);
  assert.match(release, /docker'.*'image'.*'inspect'.*'--format'/s);
  assert.match(release, /--no-build/);
  assert.match(release, /rollback 검증 실패로 원 release/);
});
