const SIGNING_SECRET_KEYS = [
  'AUTH_JWT_SECRET',
  'SERVE_TOKEN_SECRET',
  'CLICK_TOKEN_SECRET',
  'ADMIN_JWT_SECRET',
] as const;

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
  const cors = required(env, 'CORS_ORIGINS').split(',').map((value) => value.trim()).filter(Boolean);
  if (!cors.length || cors.includes('*')) throw new Error('운영 설정 오류(CORS_ORIGINS): 명시적인 HTTPS origin이 필요합니다.');
  for (const origin of cors) httpsOrigin(origin, 'CORS_ORIGINS');

  if (env.ADMIN_BOOTSTRAP_ENABLED === 'true') {
    required(env, 'ADMIN_BOOTSTRAP_EMAIL');
    required(env, 'ADMIN_BOOTSTRAP_PASSWORD');
  } else if (env.ADMIN_BOOTSTRAP_PASSWORD) {
    throw new Error('운영 설정 오류(ADMIN_BOOTSTRAP_PASSWORD): 부트스트랩 비활성화 후 시크릿을 제거해야 합니다.');
  }
}
