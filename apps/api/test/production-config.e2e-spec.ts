import { validateProductionEnv } from '../src/config/production-env';

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DB_HOST: 'postgres', DB_PORT: '5432', DB_USER: 'clawad', DB_PASSWORD: 'database-secret', DB_NAME: 'clawad',
    REDIS_HOST: 'redis', REDIS_PORT: '6379', AUTH_COOKIE_SECURE: 'true',
    SOCIAL_CALLBACK_BASE_URL: 'https://api.example.com', SOCIAL_RETURN_ALLOWLIST: 'https://app.example.com',
    SOCIAL_METRICS_RETENTION_DAYS: '30',
    CORS_ORIGINS: 'https://app.example.com',
    SOCIAL_GOOGLE_ENABLED: 'true', SOCIAL_GOOGLE_CLIENT_ID: 'google-client', SOCIAL_GOOGLE_CLIENT_SECRET: 'google-secret',
    SOCIAL_KAKAO_ENABLED: 'true', SOCIAL_KAKAO_CLIENT_ID: 'kakao-client', SOCIAL_KAKAO_CLIENT_SECRET: 'kakao-secret',
    SOCIAL_NAVER_ENABLED: 'true', SOCIAL_NAVER_CLIENT_ID: 'naver-client', SOCIAL_NAVER_CLIENT_SECRET: 'naver-secret',
    AUTH_JWT_SECRET: 'a'.repeat(32), SERVE_TOKEN_SECRET: 'b'.repeat(32),
    CLICK_TOKEN_SECRET: 'c'.repeat(32), ADMIN_JWT_SECRET: 'd'.repeat(32),
    ADMIN_BOOTSTRAP_ENABLED: 'false',
    LEGAL_TERMS_VERSION: '2026-07', LEGAL_TERMS_URL: 'https://clawad.example.com/legal/terms',
    LEGAL_TERMS_EFFECTIVE_AT: '2026-07-14', LEGAL_PRIVACY_VERSION: '2026-07',
    LEGAL_PRIVACY_URL: 'https://clawad.example.com/legal/privacy', LEGAL_PRIVACY_EFFECTIVE_AT: '2026-07-14',
    LEGAL_PRIVACY_CONTACT_URL: 'https://clawad.example.com/privacy/contact',
    LEGAL_REMOVAL_GUIDE_URL: 'https://clawad.example.com/help/remove',
  };
}

describe('운영 환경 검증', () => {
  it('분리된 비밀값과 HTTPS origin을 허용한다', () => expect(() => validateProductionEnv(validEnv())).not.toThrow());

  it('서명 키 재사용을 거부한다', () => {
    const env = validEnv();
    env.SERVE_TOKEN_SECRET = env.AUTH_JWT_SECRET;
    expect(() => validateProductionEnv(env)).toThrow(/SIGNING_SECRETS/);
  });

  it('HTTP callback과 와일드카드 CORS를 거부한다', () => {
    const callbackEnv = validEnv();
    callbackEnv.SOCIAL_CALLBACK_BASE_URL = 'http://api.example.com';
    expect(() => validateProductionEnv(callbackEnv)).toThrow(/SOCIAL_CALLBACK_BASE_URL/);
    const corsEnv = validEnv();
    corsEnv.CORS_ORIGINS = '*';
    expect(() => validateProductionEnv(corsEnv)).toThrow(/CORS_ORIGINS/);
  });

  it('활성 OAuth 공급자의 누락된 자격 증명과 HTTP return origin을 거부한다', () => {
    const missingSecret = validEnv();
    delete missingSecret.SOCIAL_KAKAO_CLIENT_SECRET;
    expect(() => validateProductionEnv(missingSecret)).toThrow(/SOCIAL_KAKAO/);
    const returnEnv = validEnv();
    returnEnv.SOCIAL_RETURN_ALLOWLIST = 'http://app.example.com';
    expect(() => validateProductionEnv(returnEnv)).toThrow(/SOCIAL_RETURN_ALLOWLIST/);
  });

  it('장애 대응을 위해 명시적으로 비활성화한 공급자는 허용한다', () => {
    const env = validEnv();
    env.SOCIAL_NAVER_ENABLED = 'false';
    delete env.SOCIAL_NAVER_CLIENT_ID;
    delete env.SOCIAL_NAVER_CLIENT_SECRET;
    expect(() => validateProductionEnv(env)).not.toThrow();
  });

  it('비활성 부트스트랩 비밀번호가 남으면 거부한다', () => {
    const env = validEnv();
    env.ADMIN_BOOTSTRAP_PASSWORD = 'must-be-removed';
    expect(() => validateProductionEnv(env)).toThrow(/ADMIN_BOOTSTRAP_PASSWORD/);
  });

  it('법률 문서의 누락·HTTP URL·잘못된 시행일을 거부한다', () => {
    const missing = validEnv();
    delete missing.LEGAL_TERMS_VERSION;
    expect(() => validateProductionEnv(missing)).toThrow(/LEGAL_TERMS_VERSION/);
    const insecure = validEnv();
    insecure.LEGAL_PRIVACY_URL = 'http://clawad.example.com/legal/privacy';
    expect(() => validateProductionEnv(insecure)).toThrow(/LEGAL_PRIVACY_URL/);
    const invalidDate = validEnv();
    invalidDate.LEGAL_TERMS_EFFECTIVE_AT = '2026-02-31';
    expect(() => validateProductionEnv(invalidDate)).toThrow(/LEGAL_TERMS_EFFECTIVE_AT/);
  });
});
