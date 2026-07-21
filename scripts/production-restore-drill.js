'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { backupDir, readLedgerSnapshot, runCompose } = require('./lib/production-compose');
const { backupObjectKey, runAws } = require('./lib/backup-replication');

const args = process.argv.slice(2);
const fromS3 = args.includes('--from-s3');
const backupFile = args.find((a) => !a.startsWith('--'));
if (!backupFile || !/^clawad-\d{8}T\d{6}Z\.dump$/.test(backupFile)) {
  throw new Error('사용법: npm run infra:prod:restore-drill -- [--from-s3] clawad-YYYYMMDDTHHMMSSZ.dump');
}

const directory = backupDir();
const backupPath = path.join(directory, backupFile);
const manifestPath = `${backupPath}.manifest.json`;

// --from-s3: EC2/EBS 손실 시나리오 복구. 외부 저장소에서 백업·manifest를 격리 환경으로 내려받는다 (CLAW-75).
if (fromS3) {
  const bucket = (process.env.BACKUP_S3_BUCKET || '').trim();
  if (!bucket) throw new Error('--from-s3에는 BACKUP_S3_BUCKET이 필요합니다.');
  const prefix = process.env.BACKUP_S3_PREFIX || 'postgres';
  const objectKey = backupObjectKey(prefix, backupFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  runAws(['s3', 'cp', `s3://${bucket}/${objectKey}`, backupPath],
    { failureMessage: 'S3에서 백업 다운로드에 실패했습니다.' });
  runAws(['s3', 'cp', `s3://${bucket}/${objectKey}.manifest.json`, manifestPath],
    { failureMessage: 'S3에서 manifest 다운로드에 실패했습니다.' });
  console.log(`외부 저장소에서 복구 대상 다운로드: s3://${bucket}/${objectKey}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== 1 || manifest.backupFile !== backupFile || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
  throw new Error('백업 manifest가 유효하지 않습니다.');
}
const actualHash = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
assert.equal(actualHash, manifest.sha256, '백업 파일 해시가 manifest와 다릅니다.');

const startedAt = Date.now();
try {
  runCompose(['--profile', 'restore-drill', 'up', '-d', '--wait', 'postgres-restore'], {
    failureMessage: '격리 복구 DB 기동에 실패했습니다.',
  });
  runCompose([
    '--profile', 'restore-drill', 'exec', '-T', 'postgres-restore', 'sh', '-c',
    `pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB" /backups/${backupFile}`,
  ], { failureMessage: '격리 복구에 실패했습니다.' });
  const snapshot = readLedgerSnapshot('postgres-restore');
  for (const value of Object.values(snapshot)) assert.match(String(value), /^-?\d+$/);
  // 완료 조건: 복구 결과(원장 건수·잔액)와 소요시간을 기록한다.
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`격리 복구 검증 완료: ${backupFile} (${fromS3 ? '외부 저장소' : '로컬'}, 소요 ${elapsedSeconds}s)`);
  console.log(`원장 무결성 스냅샷: ${JSON.stringify(snapshot)}`);
} finally {
  runCompose(['--profile', 'restore-drill', 'rm', '-s', '-f', 'postgres-restore'], {
    failureMessage: '격리 복구 컨테이너 정리에 실패했습니다.',
  });
}
