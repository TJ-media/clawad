'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { backupDir, textfileDir, runCompose } = require('./lib/production-compose');
const {
  backupObjectKey,
  assertNoSecrets,
  renderBackupMetrics,
  runAws,
} = require('./lib/backup-replication');

const directory = backupDir();
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
const backupFile = `clawad-${stamp}.dump`;

runCompose([
  'exec', '-T', 'postgres', 'sh', '-c',
  `pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --file=/backups/${backupFile}`,
], { failureMessage: 'PostgreSQL 백업 생성에 실패했습니다.' });

const localBackup = path.join(directory, backupFile);
if (!fs.existsSync(localBackup) || fs.statSync(localBackup).size === 0) {
  throw new Error('생성된 백업 파일을 확인할 수 없습니다. BACKUP_DIR 마운트를 점검하세요.');
}
const sha256 = createHash('sha256').update(fs.readFileSync(localBackup)).digest('hex');
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  backupFile,
  sha256,
};
const manifestPath = `${localBackup}.manifest.json`;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
try {
  fs.chmodSync(localBackup, 0o600);
} catch (error) {
  if (process.platform !== 'win32') throw error;
}
console.log(`백업 완료: ${backupFile}`);

// --- 외부 저장소(S3) 복제 (CLAW-75) ---------------------------------------
// EC2/EBS 동반 손실을 막기 위해 백업을 독립 저장소로 복제한다.
// BACKUP_S3_BUCKET이 없으면 로컬 백업만 수행한다(개발·기존 동작 유지).
const bucket = (process.env.BACKUP_S3_BUCKET || '').trim();
let uploadVerified = false;

if (bucket) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('BACKUP_S3_BUCKET 이름이 S3 규칙에 맞지 않습니다.');
  }
  const prefix = process.env.BACKUP_S3_PREFIX || 'postgres';
  const sse = process.env.BACKUP_S3_SSE || 'AES256'; // 저장 암호화. KMS는 'aws:kms' + BACKUP_S3_SSE_KMS_KEY_ID.
  const objectKey = backupObjectKey(prefix, backupFile);
  const manifestKey = `${objectKey}.manifest.json`;
  const sseArgs = ['--sse', sse];
  if (sse === 'aws:kms' && process.env.BACKUP_S3_SSE_KMS_KEY_ID) {
    sseArgs.push('--sse-kms-key-id', process.env.BACKUP_S3_SSE_KMS_KEY_ID);
  }

  // 전송은 TLS(aws CLI 기본). 저장은 SSE. 자격증명은 인스턴스 역할(IAM)로 코드가 키를 다루지 않는다.
  runAws(['s3', 'cp', localBackup, `s3://${bucket}/${objectKey}`, ...sseArgs],
    { failureMessage: 'S3 백업 업로드에 실패했습니다.' });
  runAws(['s3', 'cp', manifestPath, `s3://${bucket}/${manifestKey}`, ...sseArgs],
    { failureMessage: 'S3 manifest 업로드에 실패했습니다.' });

  // 업로드 후 검증: 원격 객체를 임시로 내려받아 해시를 manifest와 대조한다(전송 중 손상 탐지).
  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-backup-verify-'));
  const verifyPath = path.join(verifyDir, backupFile);
  try {
    runAws(['s3', 'cp', `s3://${bucket}/${objectKey}`, verifyPath],
      { failureMessage: '업로드 검증용 다운로드에 실패했습니다.' });
    const remoteHash = createHash('sha256').update(fs.readFileSync(verifyPath)).digest('hex');
    if (remoteHash !== sha256) {
      throw new Error('업로드된 백업의 해시가 로컬 manifest와 다릅니다. 복제를 신뢰할 수 없습니다.');
    }
    uploadVerified = true;
  } finally {
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }
  // 로그에 버킷·키만 남기고 자격증명·URL 시크릿이 없는지 확인한다.
  const line = `외부 복제 완료(검증됨): s3://${bucket}/${objectKey}`;
  assertNoSecrets(line, '백업 로그');
  console.log(line);
}

// --- 모니터링 메트릭(node-exporter textfile) ------------------------------
// 마지막 성공 시각·크기·업로드 검증을 노출해 alerts.yml이 백업 지연·실패를 감시한다.
const metricsDir = textfileDir();
if (metricsDir) {
  const metrics = renderBackupMetrics({
    lastSuccessEpochSeconds: Math.floor(Date.now() / 1000),
    sizeBytes: fs.statSync(localBackup).size,
    verified: bucket ? uploadVerified : false,
  });
  assertNoSecrets(metrics, '백업 메트릭');
  fs.mkdirSync(metricsDir, { recursive: true });
  // node-exporter가 부분 파일을 읽지 않도록 원자적 rename으로 쓴다.
  const target = path.join(metricsDir, 'clawad_backup.prom');
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, metrics, { mode: 0o644 });
  fs.renameSync(temporary, target);
}
