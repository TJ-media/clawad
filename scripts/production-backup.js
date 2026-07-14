'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { backupDir, runCompose } = require('./lib/production-compose');

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
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  backupFile,
  sha256: createHash('sha256').update(fs.readFileSync(localBackup)).digest('hex'),
};
const manifestPath = `${localBackup}.manifest.json`;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
try {
  fs.chmodSync(localBackup, 0o600);
} catch (error) {
  if (process.platform !== 'win32') throw error;
}
console.log(`백업 완료: ${backupFile}`);
