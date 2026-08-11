'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
  // 수신기(Mattermost)가 Alertmanager 스키마를 거부하므로 alert-bridge가 변환한다 (CLAW-81).
  // Alertmanager는 내부 브리지로만 보내고 수신기 URL은 브리지가 시크릿으로 보유한다.
  assert.match(read('deploy/production/observability/alertmanager.yml'), /url: http:\/\/alert-bridge:9099\/alert/);
  assert.doesNotMatch(read('deploy/production/observability/alertmanager.yml'), /url_file:/);
  // depends_on의 alert-bridge 항목이 아니라 최상위 서비스 정의 블록을 집는다.
  const bridge = read('deploy/production/compose.yml').split(/\r?\n {2}alert-bridge:\r?\n/)[1] || '';
  assert.match(bridge, /secrets: \[alert_webhook_url\]/, '브리지가 수신기 시크릿을 보유해야 한다');
  const alerts = read('deploy/production/observability/alerts.yml');
  assert.match(alerts, /ClawadOAuthFailureRate[\s\S]*increase\(clawad_oauth_events_total[\s\S]*\[10m\]\)/);
  assert.doesNotMatch(alerts, /delta\(clawad_oauth_events_total/);
  assert.match(alerts, /ClawadAdDecisionHighLatency/);
  assert.match(alerts, /ClawadObservabilityQueryFailed/);
  assert.match(alerts, /ClawadEmergencyStopActive/);
  const dashboard = JSON.parse(read('deploy/production/observability/grafana/dashboards/alpha-overview.json'));
  assert.equal(dashboard.uid, 'clawad-alpha-overview');
});

test('백업은 자동 실행되고, 침묵과 디스크 축적을 막는다 (CLAW-185)', () => {
  // 배포 시·수동 실행뿐이면 RPO가 보장되지 않는다.
  const timer = read('deploy/production/systemd/clawad-backup.timer');
  assert.match(timer, /OnCalendar=/);
  // 재부팅으로 놓친 실행을 따라잡지 않으면 하루가 조용히 비어버린다.
  assert.match(timer, /Persistent=true/);
  const unit = read('deploy/production/systemd/clawad-backup.service');
  assert.match(unit, /ExecStart=.*scripts\/production-backup\.js/);
  assert.match(unit, /EnvironmentFile=.*deploy\/production\/\.env/);

  // ClawadBackupStale은 메트릭이 아예 없으면 평가되지 않아 영원히 침묵한다.
  const alerts = read('deploy/production/observability/alerts.yml');
  assert.match(alerts, /absent\(clawad_backup_last_success_timestamp_seconds\)/);

  // 30GiB 볼륨에 dump가 무기한 쌓이면 백업 자체가 실패한다.
  assert.match(read('deploy/production/.env.example'), /BACKUP_LOCAL_RETENTION_DAYS=\d+/);
  assert.match(read('scripts/production-backup.js'), /expiredLocalBackups/);

  // DR 재프로비저닝 직후 production-release.js(node)·백업 복제(aws)를 바로 실행할 수 있어야 한다.
  const userData = read('deploy/terraform/aws/user-data.sh');
  assert.match(userData, /awscli/);
  assert.match(userData, /nodesource\.com\/setup_24\.x/, 'apt nodejs는 18.x라 요구 버전 24와 맞지 않는다');
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

test('배포 실패는 알림으로 새어 나가고, .env 백업이 배포를 막지 않는다', () => {
  // 미커밋 파일 하나가 2026-07-29~08-02 나흘간 모든 배포를 조용히 막았다 (CLAW-153).
  const workflow = read('.github/workflows/production-deploy.yml');
  assert.match(workflow, /^  notify:$/m);
  assert.match(workflow, /^    if: failure\(\)$/m);
  assert.match(workflow, /needs: \[verify, deploy\]/);
  assert.match(workflow, /secrets\.MATTERMOST_WEBHOOK_URL/);
  // 알림 본문에 인프라 식별자를 싣지 않는다 (CLAW-80).
  const notify = workflow.slice(workflow.indexOf('  notify:'));
  assert.doesNotMatch(notify, /INSTANCE_ID|ECR_REGISTRY|AWS_DEPLOY_ROLE_ARN/);

  // 가드에 걸린 파일명이 워크플로 로그에 남아야 원인을 찾을 수 있다.
  const release = read('scripts/production-release.js');
  assert.match(release, /배포를 거부했습니다\.\\n\$\{worktree\}/);

  // 규칙 문자열 존재가 아니라 git이 실제로 무시하는지로 확인한다.
  const ignored = execFileSync('git', ['check-ignore', 'deploy/production/.env.bak-20260729-052643'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.equal(ignored, 'deploy/production/.env.bak-20260729-052643');
});

test('배포 폴링 소진과 알림 누락은 잡 실패로 드러난다 (CLAW-178)', () => {
  // SSM 폴링이 InProgress로 소진돼도 성공으로 위장하면 CLAW-153의 침묵이 재발한다.
  const workflow = read('.github/workflows/production-deploy.yml');
  const deployJob = workflow.slice(workflow.indexOf('  deploy:'), workflow.indexOf('  notify:'));
  // 폴링 창(240 × 15s)이 SSM executionTimeout(3600s)을 덮는다.
  assert.match(deployJob, /seq 1 240/);
  assert.match(deployJob, /--timeout-seconds 3600/);
  // 루프가 Success 없이 끝나면 배포를 실패시킨다.
  const guardIdx = deployJob.indexOf('"${STATUS}" != "Success"');
  assert.ok(guardIdx !== -1, '폴링 후 STATUS != Success 가드가 있어야 한다');
  assert.match(deployJob.slice(guardIdx), /exit 1/);
  // 알림 웹훅이 없으면 조용히 넘기지 않고 잡을 실패시킨다.
  const notify = workflow.slice(workflow.indexOf('  notify:'));
  assert.match(notify, /시크릿이 없어[\s\S]*?exit 1/);
  assert.doesNotMatch(notify, /exit 0/);
});
