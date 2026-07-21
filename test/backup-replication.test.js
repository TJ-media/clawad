'use strict';

// CLAW-75 백업 외부 복제 순수 로직 스모크. aws CLI 호출은 제외하고 파일명·키·메트릭·시크릿 스캔만 검증한다.
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseBackupFileName,
  backupObjectKey,
  assertNoSecrets,
  renderBackupMetrics,
} = require('../scripts/lib/backup-replication');

test('백업 파일명 규약을 검증하고 연·월을 추출한다', () => {
  assert.deepEqual(parseBackupFileName('clawad-20260718T031500Z.dump'), { year: '2026', month: '07' });
  assert.equal(parseBackupFileName('clawad-bad.dump'), null);
  assert.equal(parseBackupFileName('evil/../clawad-20260718T031500Z.dump'), null);
  assert.equal(parseBackupFileName(''), null);
});

test('S3 객체 키는 prefix/연/월/파일 구조다', () => {
  assert.equal(
    backupObjectKey('postgres', 'clawad-20260718T031500Z.dump'),
    'postgres/2026/07/clawad-20260718T031500Z.dump',
  );
  assert.equal(
    backupObjectKey('/alpha/db/', 'clawad-20260718T031500Z.dump'),
    'alpha/db/2026/07/clawad-20260718T031500Z.dump',
  );
});

test('잘못된 파일명·prefix로 키를 만들지 않는다', () => {
  assert.throws(() => backupObjectKey('postgres', 'clawad-bad.dump'), /규약에 맞지 않습니다/);
  assert.throws(() => backupObjectKey('../evil', 'clawad-20260718T031500Z.dump'), /유효하지 않습니다/);
  assert.throws(() => backupObjectKey('a b', 'clawad-20260718T031500Z.dump'), /유효하지 않습니다/);
});

test('로그·메트릭에 시크릿이 있으면 기록을 거부한다', () => {
  assert.throws(() => assertNoSecrets('key=AKIAIOSFODNN7EXAMPLE'), /시크릿/);
  assert.throws(() => assertNoSecrets('postgres://user:pass@db:5432/clawad'), /시크릿/);
  assert.throws(() => assertNoSecrets('token eyJhbGc.eyJzdWI.abc123def'), /시크릿/);
  assert.throws(() => assertNoSecrets('DB_PASSWORD=hunter2'), /시크릿/);
  assert.throws(() => assertNoSecrets('client_secret: abcdef'), /시크릿/);
  // 정상 로그(버킷·키만)는 통과한다.
  assert.equal(
    assertNoSecrets('외부 복제 완료: s3://clawad-alpha-backups/postgres/2026/07/clawad-20260718T031500Z.dump'),
    '외부 복제 완료: s3://clawad-alpha-backups/postgres/2026/07/clawad-20260718T031500Z.dump',
  );
});

test('에러 메시지에 시크릿 원문을 재노출하지 않는다', () => {
  try {
    assertNoSecrets('key=AKIAIOSFODNN7EXAMPLE', '테스트');
    assert.fail('throw 했어야 한다');
  } catch (error) {
    assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(error.message), '에러 메시지에 원문이 없어야 한다');
    assert.match(error.message, /테스트/);
  }
});

test('node-exporter textfile 메트릭을 렌더한다', () => {
  const out = renderBackupMetrics({ lastSuccessEpochSeconds: 1789000000, sizeBytes: 12345, verified: true });
  assert.match(out, /clawad_backup_last_success_timestamp_seconds 1789000000/);
  assert.match(out, /clawad_backup_last_success_bytes 12345/);
  assert.match(out, /clawad_backup_last_upload_verified 1/);
  assert.match(out, /# TYPE clawad_backup_last_success_timestamp_seconds gauge/);
  assert.ok(out.endsWith('\n'), 'textfile 메트릭은 개행으로 끝나야 한다');
});

test('미검증 업로드는 verified 0으로 노출한다', () => {
  const out = renderBackupMetrics({ lastSuccessEpochSeconds: 1789000000, sizeBytes: 0, verified: false });
  assert.match(out, /clawad_backup_last_upload_verified 0/);
});

test('잘못된 메트릭 입력은 거부한다', () => {
  assert.throws(() => renderBackupMetrics({ lastSuccessEpochSeconds: 0, sizeBytes: 1, verified: true }), /양수/);
  assert.throws(() => renderBackupMetrics({ lastSuccessEpochSeconds: 1, sizeBytes: -1, verified: true }), /0 이상 정수/);
});
