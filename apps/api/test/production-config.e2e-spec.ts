import { validateProductionEnv } from '../src/config/production-env';

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DB_HOST: 'postgres', DB_PORT: '5432', DB_USER: 'clawad', DB_PASSWORD: 'database-secret', DB_NAME: 'clawad',
    REDIS_HOST: 'redis', REDIS_PORT: '6379', AUTH_COOKIE_SECURE: 'true',
    SOCIAL_CALLBACK_BASE_URL: 'https://api.example.com', CORS_ORIGINS: 'https://app.example.com',
    AUTH_JWT_SECRET: 'a'.repeat(32), SERVE_TOKEN_SECRET: 'b'.repeat(32),
    CLICK_TOKEN_SECRET: 'c'.repeat(32), ADMIN_JWT_SECRET: 'd'.repeat(32),
    ADMIN_BOOTSTRAP_ENABLED: 'false',
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

  it('비활성 부트스트랩 비밀번호가 남으면 거부한다', () => {
    const env = validEnv();
    env.ADMIN_BOOTSTRAP_PASSWORD = 'must-be-removed';
    expect(() => validateProductionEnv(env)).toThrow(/ADMIN_BOOTSTRAP_PASSWORD/);
  });
});
