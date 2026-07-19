'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEPLOY_DIR = path.join(ROOT_DIR, 'deploy', 'production');
const COMPOSE_FILE = path.join(DEPLOY_DIR, 'compose.yml');

function runCompose(args, options = {}) {
  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(options.failureMessage || `docker compose 명령이 실패했습니다 (${result.status})`);
  }
  return options.capture ? result.stdout.trim() : '';
}

function backupDir(env = process.env) {
  const configured = env.BACKUP_DIR || './backups';
  return path.isAbsolute(configured) ? configured : path.resolve(DEPLOY_DIR, configured);
}

// 상대경로는 compose 파일 위치(DEPLOY_DIR) 기준으로 해석해, 스크립트가 쓰는 위치와
// node-exporter 볼륨 마운트(${NODE_EXPORTER_TEXTFILE_DIR:-./textfile})가 어긋나지 않게 한다 (CLAW-75).
function textfileDir(env = process.env) {
  const configured = (env.NODE_EXPORTER_TEXTFILE_DIR || '').trim();
  if (!configured) return '';
  return path.isAbsolute(configured) ? configured : path.resolve(DEPLOY_DIR, configured);
}

function readLedgerSnapshot(service) {
  const sql = [
    'SELECT json_build_object(',
    "'billingLedgerCount', (SELECT COUNT(*)::text FROM billing_ledger),",
    "'billingBalanceKrw', (SELECT COALESCE(SUM(\"amountKrw\"),0)::text FROM billing_ledger),",
    "'rewardLedgerCount', (SELECT COUNT(*)::text FROM reward_ledger),",
    "'rewardBalancePoints', (SELECT COALESCE(SUM(points),0)::text FROM reward_ledger),",
    "'impressionEventCount', (SELECT COUNT(*)::text FROM impression_events),",
    "'auditLogCount', (SELECT COUNT(*)::text FROM audit_logs)",
    ');',
  ].join(' ');
  const profile = service === 'postgres-restore' ? ['--profile', 'restore-drill'] : [];
  const output = runCompose(
    [...profile, 'exec', '-T', service, 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$1"', '--', sql],
    { capture: true, failureMessage: '원장 검증 스냅샷 생성에 실패했습니다.' },
  );
  return JSON.parse(output);
}

module.exports = { backupDir, textfileDir, readLedgerSnapshot, runCompose };
