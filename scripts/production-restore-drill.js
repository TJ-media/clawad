'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { backupDir, readLedgerSnapshot, runCompose } = require('./lib/production-compose');

const backupFile = process.argv[2];
if (!backupFile || !/^clawad-\d{8}T\d{6}Z\.dump$/.test(backupFile)) {
  throw new Error('사용법: npm run infra:prod:restore-drill -- clawad-YYYYMMDDTHHMMSSZ.dump');
}
const manifestPath = path.join(backupDir(), `${backupFile}.manifest.json`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== 1 || manifest.backupFile !== backupFile || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
  throw new Error('백업 manifest가 유효하지 않습니다.');
}
const backupPath = path.join(backupDir(), backupFile);
const actualHash = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
assert.equal(actualHash, manifest.sha256, '백업 파일 해시가 manifest와 다릅니다.');

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
  console.log(`격리 복구 검증 완료: ${backupFile}`);
} finally {
  runCompose(['--profile', 'restore-drill', 'rm', '-s', '-f', 'postgres-restore'], {
    failureMessage: '격리 복구 컨테이너 정리에 실패했습니다.',
  });
}
