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

test('관리자 대시보드는 SSM용 loopback과 내부 API에만 연결된다 (CLAW-241)', () => {
  const coreCompose = read('deploy/production/compose.yml');
  assert.doesNotMatch(coreCompose, /admin-web|ADMIN_WEB_RELEASE_SHA|ADMIN_WEB_PORT/);

  const compose = read('deploy/production/admin-compose.yml');
  const start = compose.indexOf('  admin-web:');
  const end = compose.indexOf('\nnetworks:', start);
  assert.notEqual(start, -1, 'admin-web 서비스가 있어야 한다');
  assert.notEqual(end, -1, 'admin-web 서비스 경계를 찾을 수 있어야 한다');
  const adminService = compose.slice(start, end);

  assert.match(adminService, /dockerfile: apps\/admin-web\/Dockerfile/);
  assert.match(adminService, /RELEASE_SHA: \$\{ADMIN_WEB_RELEASE_SHA:\?ADMIN_WEB_RELEASE_SHA is required\}/);
  assert.match(adminService, /clawad-admin-web:\$\{ADMIN_WEB_RELEASE_SHA:\?ADMIN_WEB_RELEASE_SHA is required\}/);
  assert.doesNotMatch(adminService, /ADMIN_WEB_RELEASE_SHA:-local/);
  assert.match(adminService, /127\.0\.0\.1:\$\{ADMIN_WEB_PORT:-3002\}:8080/);
  assert.match(adminService, /networks: \[backend, host-access\]/);
  assert.doesNotMatch(adminService, /\bedge\b/);
  assert.match(adminService, /127\.0\.0\.1:8080\/healthz/);
  assert.match(compose, /external: true/);
  assert.match(compose, /name: \$\{ADMIN_BACKEND_NETWORK:-clawad-production_backend\}/);
  assert.match(compose, /host-access:\n\s+driver: bridge/);

  const adminCaddy = read('apps/admin-web/Caddyfile');
  assert.match(adminCaddy, /@health path \/healthz[\s\S]*rewrite \* \/health\/ready[\s\S]*reverse_proxy api:3000/);
  assert.match(adminCaddy, /@adminApi path \/admin\/v1\/\* \/internal\/v1\/\*/);
  assert.match(adminCaddy, /reverse_proxy @adminApi api:3000/);
  assert.match(adminCaddy, /connect-src 'self'/);

  const publicEdge = read('deploy/production/Caddyfile');
  assert.doesNotMatch(publicEdge, /admin-web|ADMIN_WEB_PORT|internal-console/);

  const dockerfile = read('apps/admin-web/Dockerfile');
  assert.match(dockerfile, /test "\$\{#RELEASE_SHA\}" -eq 40/);
  assert.match(dockerfile, /\*\[!0-9a-f\]\*/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$RELEASE_SHA/);

  const runbook = read('docs/operations/production-deployment.md');
  assert.match(runbook, /AWS-StartPortForwardingSession/);
  assert.match(runbook, /http:\/\/127\.0\.0\.1:3002/);
  assert.match(runbook, /set -euo pipefail/);
  assert.match(runbook, /git status --porcelain/);
  assert.match(runbook, /docker image inspect/);
  assert.match(runbook, /internal\/v1\/analytics\/alpha-overview/);
  assert.match(runbook, /401/);
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
  // 제보 알림은 운영 알림과 같은 채널을 쓴다 (CLAW-234). 새 시크릿을 만들지 않고 재사용한다.
  assert.match(compose, /REPORT_WEBHOOK_URL_FILE: \/run\/secrets\/alert_webhook_url/);
  assert.match(compose, /secrets: \[monitoring_token, alert_webhook_url\]/,
    'api가 제보 알림 웹훅 시크릿을 보유해야 한다');
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

test('시크릿은 재부팅에 살아남고 알림 경로는 스스로를 감시한다 (CLAW-179)', () => {
  // 시크릿이 tmpfs(/run)에 있으면 재부팅 시 소실 → compose 시크릿 마운트 실패 →
  // api·prometheus·grafana·alert-bridge 연쇄 미기동 → 장애를 알릴 주체가 사라진다.
  const env = read('deploy/production/.env.example');
  const secretFiles = [...env.matchAll(/^([A-Z0-9_]+_FILE)=(.+)$/gm)];
  assert.ok(secretFiles.length >= 3, '_FILE 시크릿 경로가 존재해야 한다');
  for (const [, key, value] of secretFiles) {
    assert.doesNotMatch(value, /^\/run\//, `${key}가 tmpfs(/run) 아래를 가리킨다`);
  }
  assert.match(env, /MONITORING_TOKEN_FILE=\/var\/lib\/clawad-secrets\//);

  // 알림 경로 자체를 스크레이프하지 않으면 경보 전달이 끊겨도 무증상이다.
  const prometheus = read('deploy/production/observability/prometheus.yml');
  assert.match(prometheus, /job_name: alertmanager/);
  assert.match(prometheus, /job_name: alert-bridge/);

  const alerts = read('deploy/production/observability/alerts.yml');
  assert.match(alerts, /ClawadAlertPathDown/);
  assert.match(alerts, /increase\(alertmanager_notifications_failed_total\[15m\]\) > 0/);
  assert.match(alerts, /alert: Watchdog[\s\S]*?expr: vector\(1\)/);

  // 상시 firing인 Watchdog이 운영 채널로 나가면 4시간마다 잡음이 된다.
  const alertmanager = read('deploy/production/observability/alertmanager.yml');
  assert.match(alertmanager, /alertname="Watchdog"[\s\S]*?receiver: deadmans-switch/);

  // 브리지 전달 실패가 console.error로만 남으면 관측 스택에서 보이지 않는다.
  assert.match(read('deploy/production/alert-bridge/server.js'), /clawad_alert_bridge_forward_total\{result="failure"\}/);

  // 호스트가 통째로 죽으면 호스트 안의 무엇도 알릴 수 없다 — AWS 쪽에서 감시한다.
  const terraform = read('deploy/terraform/aws/main.tf');
  assert.match(terraform, /resource "aws_cloudwatch_metric_alarm"[\s\S]*?metric_name\s*=\s*"StatusCheckFailed"/);
  assert.match(terraform, /treat_missing_data\s*=\s*"breaching"/);
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

// 배포 경로와 systemd 타이머 경로가 서로 다른 환경변수를 보면, 백업이 "성공"으로 끝나면서
// 외부 복제와 메트릭 기록만 조용히 빠진다. 실제로 그래서 clawad_backup.prom이 한 번도
// 기록되지 않았고 ClawadBackupStale이 평가조차 되지 않았다 (CLAW-192).
test('배포가 넘기는 백업 환경변수가 백업 스크립트가 읽는 값을 모두 덮는다 (CLAW-192)', () => {
  const backupSources = [
    'scripts/production-backup.js',
    'scripts/lib/production-compose.js',
    'scripts/lib/backup-replication.js',
  ].map(read).join('\n');

  const needed = [...new Set(
    [...backupSources.matchAll(/env\.([A-Z0-9_]+)/g)]
      .map((m) => m[1])
      .filter((key) => key.startsWith('BACKUP_') || key.startsWith('NODE_EXPORTER_')),
  )];
  assert.ok(needed.length >= 5, `백업 환경변수를 찾지 못했다: ${needed.join(', ')}`);

  const release = read('scripts/production-release.js');
  const start = release.indexOf('const BACKUP_ENV_KEYS = [');
  assert.ok(start !== -1, 'production-release.js에 BACKUP_ENV_KEYS 허용목록이 있어야 한다');
  const allowlist = release.slice(start, release.indexOf('];', start));

  for (const key of needed) {
    assert.ok(allowlist.includes(`'${key}'`), `${key}가 BACKUP_ENV_KEYS에 없어 배포 경로에서 빠진다`);
  }
});

// SSE-S3는 버킷 접근 권한만 있으면 평문이 나온다. 기본값을 KMS로 둔다 (CLAW-192).
test('백업 저장 암호화 기본값이 SSE-KMS다 (CLAW-192)', () => {
  const env = read('deploy/production/.env.example');
  assert.match(env, /^BACKUP_S3_SSE=aws:kms$/m);
  // AWS 관리 키(aws/s3)를 쓰므로 키 ID는 비워둔다. CMK 도입 시 채운다.
  assert.match(env, /^BACKUP_S3_SSE_KMS_KEY_ID=$/m);
});

// 호스트 런타임이 저장소 요구 버전보다 낮으면 CI는 통과하고 호스트에서만 깨진다 (CLAW-193).
// 자동 실행 경로(배포·백업·복원 드릴)가 모두 거치는 공통 모듈에서 한 번에 막는다.
test('운영 스크립트는 Node 24 미만에서 fail-fast한다 (CLAW-193)', () => {
  const shared = read('scripts/lib/production-compose.js');
  assert.match(shared, /REQUIRED_NODE_MAJOR = 24/);
  assert.match(shared, /process\.versions\.node/);
  assert.match(shared, /throw new Error\(/);

  // 가드는 이 모듈을 거치는 스크립트에만 걸린다. 자동으로 도는 경로는 반드시 거쳐야 한다.
  for (const name of ['production-release.js', 'production-backup.js', 'production-restore-drill.js']) {
    assert.match(read(`scripts/${name}`), /require\('\.\/lib\/production-compose'\)/, `${name}이 공통 진입 모듈을 거치지 않아 가드가 적용되지 않는다`);
  }

  // 기존 호스트는 user-data로 갱신되지 않으므로 수동 절차가 문서에 있어야 한다.
  const doc = read('docs/operations/production-deployment.md');
  assert.match(doc, /nodesource\.com\/setup_24\.x/);
  assert.match(doc, /user-data는 프로비저닝 때 한 번만 실행/);
});
