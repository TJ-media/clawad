import { isStrictIsoDate } from '../legal/legal-validation';

const SIGNING_SECRET_KEYS = [
  'AUTH_JWT_SECRET',
  'SERVE_TOKEN_SECRET',
  'CLICK_TOKEN_SECRET',
  'ADMIN_JWT_SECRET',
] as const;
const SOCIAL_PROVIDERS = ['GOOGLE', 'KAKAO', 'NAVER'] as const;

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

function httpsUrl(value: string, key: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`운영 설정 오류(${key}): 올바른 URL이 아닙니다.`); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`운영 설정 오류(${key}): 자격증명 없는 HTTPS URL이어야 합니다.`);
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

  for (const prefix of ['LEGAL_TERMS', 'LEGAL_PRIVACY']) {
    const version = required(env, `${prefix}_VERSION`);
    if (version.length > 32) throw new Error(`운영 설정 오류(${prefix}_VERSION): 32자 이하여야 합니다.`);
    httpsUrl(required(env, `${prefix}_URL`), `${prefix}_URL`);
    const effectiveAt = required(env, `${prefix}_EFFECTIVE_AT`);
    if (!isStrictIsoDate(effectiveAt)) {
      throw new Error(`운영 설정 오류(${prefix}_EFFECTIVE_AT): YYYY-MM-DD 형식이어야 합니다.`);
    }
  }
  httpsUrl(required(env, 'LEGAL_PRIVACY_CONTACT_URL'), 'LEGAL_PRIVACY_CONTACT_URL');
  httpsUrl(required(env, 'LEGAL_REMOVAL_GUIDE_URL'), 'LEGAL_REMOVAL_GUIDE_URL');

  if (env.ADMIN_BOOTSTRAP_ENABLED === 'true') {
    required(env, 'ADMIN_BOOTSTRAP_EMAIL');
    required(env, 'ADMIN_BOOTSTRAP_PASSWORD');
  } else if (env.ADMIN_BOOTSTRAP_PASSWORD) {
    throw new Error('운영 설정 오류(ADMIN_BOOTSTRAP_PASSWORD): 부트스트랩 비활성화 후 시크릿을 제거해야 합니다.');
  }
}
