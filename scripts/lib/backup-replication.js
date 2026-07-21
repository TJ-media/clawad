'use strict';

// CLAW-75 백업 외부 복제 공용 로직.
// 순수 함수(파일명·키·메트릭·시크릿 스캔)와 aws CLI 래퍼를 분리해 순수 로직만 단위 테스트한다.
// 무의존성: node 내장 + aws CLI(spawnSync). AWS SDK를 추가하지 않는다(docker CLI 래퍼와 같은 패턴).

const { spawnSync } = require('node:child_process');

// production-backup.js가 만드는 백업 파일명 규약. restore-drill과 동일해야 한다.
const BACKUP_FILE_PATTERN = /^clawad-(\d{4})(\d{2})(\d{2})T\d{6}Z\.dump$/;

// 로그·manifest·메트릭에 새어나가면 안 되는 시크릿 패턴(백업 파일 내용이 아니라 부수 출력물 검사용).
// AWS 키, DB 접속 문자열, JWT/Bearer, client secret, 비밀번호 대입 형태를 막는다.
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,                         // AWS access key id
  /aws_secret_access_key/i,
  /postgres(?:ql)?:\/\/[^\s]*:[^\s]*@/i,      // DB URL with credentials
  /redis:\/\/[^\s]*:[^\s]*@/i,
  /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/, // JWT
  /bearer\s+[a-z0-9._-]{12,}/i,
  /client[_-]?secret/i,
  /(?:password|passwd|pwd)\s*[=:]\s*\S+/i,
];

/** 백업 파일명이 규약을 따르는지 검증하고 연/월을 반환한다. 아니면 null. */
function parseBackupFileName(name) {
  const match = BACKUP_FILE_PATTERN.exec(name || '');
  if (!match) return null;
  return { year: match[1], month: match[2] };
}

/**
 * S3 객체 키. 연/월 프리픽스로 나눠 수명주기·조회를 쉽게 한다.
 * prefix는 영숫자·`-`·`/`만 허용(주입·경로탈출 방지).
 */
function backupObjectKey(prefix, backupFile) {
  const parsed = parseBackupFileName(backupFile);
  if (!parsed) throw new Error(`백업 파일명이 규약에 맞지 않습니다: ${backupFile}`);
  const cleanPrefix = String(prefix || 'postgres').replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(cleanPrefix)) {
    throw new Error(`S3 prefix가 유효하지 않습니다: ${prefix}`);
  }
  return `${cleanPrefix}/${parsed.year}/${parsed.month}/${backupFile}`;
}

/** 부수 출력물(로그·manifest·메트릭 라벨)에 시크릿이 없는지 검증한다. 있으면 throw. */
function assertNoSecrets(text, where = '출력') {
  const value = String(text);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      // 매칭된 원문을 에러에 담지 않는다(재노출 방지). 위치·패턴 인덱스만 알린다.
      throw new Error(`${where}에 시크릿으로 보이는 값이 포함되어 기록을 거부합니다.`);
    }
  }
  return value;
}

/**
 * node-exporter textfile collector가 읽는 Prometheus 노출 포맷을 만든다.
 * 백업 성공 시각·크기·업로드 검증 결과를 게이지로 노출해 alerts.yml이 지연을 감시한다.
 */
function renderBackupMetrics({ lastSuccessEpochSeconds, sizeBytes, verified }) {
  if (!Number.isFinite(lastSuccessEpochSeconds) || lastSuccessEpochSeconds <= 0) {
    throw new Error('lastSuccessEpochSeconds는 양수여야 합니다.');
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error('sizeBytes는 0 이상 정수여야 합니다.');
  }
  const verifiedValue = verified ? 1 : 0;
  return [
    '# HELP clawad_backup_last_success_timestamp_seconds 마지막 성공한 외부 백업 복제의 완료 시각(epoch).',
    '# TYPE clawad_backup_last_success_timestamp_seconds gauge',
    `clawad_backup_last_success_timestamp_seconds ${Math.floor(lastSuccessEpochSeconds)}`,
    '# HELP clawad_backup_last_success_bytes 마지막 성공한 백업 파일 크기(bytes).',
    '# TYPE clawad_backup_last_success_bytes gauge',
    `clawad_backup_last_success_bytes ${sizeBytes}`,
    '# HELP clawad_backup_last_upload_verified 업로드 후 체크섬 재검증 성공 여부(1/0).',
    '# TYPE clawad_backup_last_upload_verified gauge',
    `clawad_backup_last_upload_verified ${verifiedValue}`,
    '',
  ].join('\n');
}

/** aws CLI 래퍼. 자격증명은 EC2 인스턴스 역할(IAM)로 제공되며 코드가 키를 다루지 않는다. */
function runAws(args, options = {}) {
  const result = spawnSync('aws', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // stderr에 접속 정보가 섞일 수 있어 원문을 그대로 전파하지 않는다.
    throw new Error(options.failureMessage || `aws 명령이 실패했습니다 (${result.status})`);
  }
  return options.capture ? result.stdout.trim() : '';
}

module.exports = {
  BACKUP_FILE_PATTERN,
  parseBackupFileName,
  backupObjectKey,
  assertNoSecrets,
  renderBackupMetrics,
  runAws,
};
