import { readFileSync } from 'node:fs';

const SIGNING_SECRET_KEYS = [
  'AUTH_JWT_SECRET',
  'SERVE_TOKEN_SECRET',
  'CLICK_TOKEN_SECRET',
  'ADMIN_JWT_SECRET',
] as const;
const SOCIAL_PROVIDERS = ['GOOGLE', 'KAKAO', 'NAVER'] as const;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MONITORING_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`운영 설정 오류(${key}): 필수 환경변수가 없습니다.`);
  return value;
}

function httpsOrigin(value: string, key: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`운영 설정 오류(${key}): 올바른 URL이 아닙니다.`); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`운영 설정 오류(${key}): 경로 없는 HTTPS origin이어야 합니다.`);
  }
}

/** 운영에서 위험한 fallback과 잘못된 시크릿 조합을 기동 전에 차단한다. */
export function validateProductionEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;

  for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'REDIS_HOST', 'REDIS_PORT']) {
    required(env, key);
  }
  if (required(env, 'DB_PASSWORD') === 'clawad_local_dev') {
    throw new Error('운영 설정 오류(DB_PASSWORD): 로컬 개발 비밀번호를 사용할 수 없습니다.');
  }
  const signingSecrets = SIGNING_SECRET_KEYS.map((key) => {
    const value = required(env, key);
    if (Buffer.byteLength(value, 'utf8') < 32) throw new Error(`운영 설정 오류(${key}): 32바이트 이상이어야 합니다.`);
    return value;
  });
  if (new Set(signingSecrets).size !== signingSecrets.length) {
    throw new Error('운영 설정 오류(SIGNING_SECRETS): 서명 키는 모두 서로 달라야 합니다.');
  }
  if (required(env, 'AUTH_COOKIE_SECURE') !== 'true') {
    throw new Error('운영 설정 오류(AUTH_COOKIE_SECURE): true여야 합니다.');
  }
  httpsOrigin(required(env, 'SOCIAL_CALLBACK_BASE_URL'), 'SOCIAL_CALLBACK_BASE_URL');
  const returns = required(env, 'SOCIAL_RETURN_ALLOWLIST').split(',').map((value) => value.trim()).filter(Boolean);
  if (!returns.length) throw new Error('운영 설정 오류(SOCIAL_RETURN_ALLOWLIST): 명시적인 HTTPS origin이 필요합니다.');
  for (const origin of returns) httpsOrigin(origin, 'SOCIAL_RETURN_ALLOWLIST');
  for (const provider of SOCIAL_PROVIDERS) {
    const enabledKey = `SOCIAL_${provider}_ENABLED`;
    const enabled = required(env, enabledKey);
    if (enabled !== 'true' && enabled !== 'false') {
      throw new Error(`운영 설정 오류(${enabledKey}): true 또는 false여야 합니다.`);
    }
    const clientId = env[`SOCIAL_${provider}_CLIENT_ID`]?.trim();
    const clientSecret = env[`SOCIAL_${provider}_CLIENT_SECRET`]?.trim();
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      throw new Error(`운영 설정 오류(SOCIAL_${provider}): client id와 secret을 함께 설정해야 합니다.`);
    }
    if (enabled === 'true' && (!clientId || !clientSecret)) {
      throw new Error(`운영 설정 오류(SOCIAL_${provider}): 활성 공급자의 운영 자격 증명이 필요합니다.`);
    }
  }
  const metricsRetentionDays = Number(required(env, 'SOCIAL_METRICS_RETENTION_DAYS'));
  if (!Number.isInteger(metricsRetentionDays) || metricsRetentionDays < 1 || metricsRetentionDays > 90) {
    throw new Error('운영 설정 오류(SOCIAL_METRICS_RETENTION_DAYS): 1~90일 정수여야 합니다.');
  }
  const cors = required(env, 'CORS_ORIGINS').split(',').map((value) => value.trim()).filter(Boolean);
  if (!cors.length || cors.includes('*')) throw new Error('운영 설정 오류(CORS_ORIGINS): 명시적인 HTTPS origin이 필요합니다.');
  for (const origin of cors) httpsOrigin(origin, 'CORS_ORIGINS');

  const releaseSha = required(env, 'RELEASE_SHA');
  const rollbackSha = required(env, 'ROLLBACK_SHA');
  if (!COMMIT_SHA_PATTERN.test(releaseSha) || new Set(releaseSha).size === 1) {
    throw new Error('운영 설정 오류(RELEASE_SHA): 실제 40자리 소문자 Git commit SHA여야 합니다.');
  }
  if (!COMMIT_SHA_PATTERN.test(rollbackSha) || new Set(rollbackSha).size === 1) {
    throw new Error('운영 설정 오류(ROLLBACK_SHA): 실제 40자리 소문자 Git commit SHA여야 합니다.');
  }
  if (releaseSha === rollbackSha) {
    throw new Error('운영 설정 오류(ROLLBACK_SHA): 현재 릴리스와 다른 복구 대상이어야 합니다.');
  }

  const monitoringTokenFile = required(env, 'MONITORING_TOKEN_FILE');
  let monitoringToken: string;
  try {
    monitoringToken = readFileSync(monitoringTokenFile, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    throw new Error('운영 설정 오류(MONITORING_TOKEN_FILE): 모니터링 시크릿 파일을 읽을 수 없습니다.');
  }
  if (!MONITORING_TOKEN_PATTERN.test(monitoringToken)) {
    throw new Error('운영 설정 오류(MONITORING_TOKEN_FILE): 32~512자의 단일 안전 토큰이어야 합니다.');
  }

  const observabilityWindowMinutes = Number(env.OBSERVABILITY_WINDOW_MINUTES ?? '15');
  if (!Number.isInteger(observabilityWindowMinutes) || observabilityWindowMinutes < 1 || observabilityWindowMinutes > 1_440) {
    throw new Error('운영 설정 오류(OBSERVABILITY_WINDOW_MINUTES): 1~1440분 정수여야 합니다.');
  }

  if (env.ADMIN_BOOTSTRAP_ENABLED === 'true') {
    required(env, 'ADMIN_BOOTSTRAP_EMAIL');
    required(env, 'ADMIN_BOOTSTRAP_PASSWORD');
  } else if (env.ADMIN_BOOTSTRAP_PASSWORD) {
    throw new Error('운영 설정 오류(ADMIN_BOOTSTRAP_PASSWORD): 부트스트랩 비활성화 후 시크릿을 제거해야 합니다.');
  }
}
