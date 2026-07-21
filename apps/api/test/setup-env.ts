import { randomBytes } from 'node:crypto';

/**
 * e2e 테스트용 환경변수. docker-compose의 로컬 인프라를 가리킨다.
 * 기본 포트(5432/6379)를 쓰지 않으므로 같은 머신의 다른 프로젝트 DB를 건드리지 않는다.
 *
 * DB/Redis는 데모용 dev(clawad / redis db 0)와 분리된 전용 대상을 쓴다 — 테스트가 데모 데이터를
 * 오염시키지 않게 한다(CLAW-39). clawad_test DB는 global-setup.js가 없으면 생성한다.
 */
process.env.DB_HOST ??= 'localhost';
process.env.DB_PORT ??= '55432';
process.env.DB_USER ??= 'clawad';
process.env.DB_PASSWORD ??= 'clawad_local_dev';
process.env.DB_NAME ??= 'clawad_test';
process.env.REDIS_HOST ??= 'localhost';
process.env.REDIS_PORT ??= '56379';
process.env.REDIS_DB ??= '1';
process.env.AUTH_JWT_SECRET ??= randomBytes(32).toString('hex');
process.env.ACCESS_TOKEN_TTL ??= '15m';
process.env.REFRESH_TOKEN_TTL_DAYS ??= '30';
process.env.SERVE_TOKEN_SECRET ??= randomBytes(32).toString('hex');
process.env.CLICK_TOKEN_SECRET ??= randomBytes(32).toString('hex');
process.env.CLAWAD_TEST_REHEARSAL_ENABLED = 'true';
process.env.ADMIN_JWT_SECRET ??= randomBytes(32).toString('hex');
process.env.ADMIN_TOKEN_TTL ??= '30m';
// 부트스트랩 SUPERADMIN. e2e에서 이 계정으로 로그인해 관리 API를 호출한다.
process.env.ADMIN_BOOTSTRAP_EMAIL ??= 'root@clawad.test';
process.env.ADMIN_BOOTSTRAP_PASSWORD ??= 'bootstrap-superadmin-pw';
// 소셜 로그인(CLAW-37). e2e는 provider 어댑터를 mock으로 override하므로 client id/secret은 필요 없다.
// SocialConfig의 redirectUri·return allowlist 검증에 쓰는 값만 채운다.
//
// 실제 공급자 격리(CLAW-77): ConfigModule은 cwd 기준 apps/api/.env를 로드하는데, 개발자 로컬 .env에
// 실제 SOCIAL_*_CLIENT_ID/SECRET가 있으면 e2e 앱의 provider가 활성화돼 "비활성 전제" 검증
// (observability의 PROVIDER_NOT_ENABLED·카운터 정확값)이 머신·cwd에 따라 비결정적으로 깨진다.
// dotenv는 이미 있는 process.env 키를 덮어쓰지 않으므로 여기 선점값이 항상 이긴다.
// CLAW-64처럼 실제 공급자로 돌릴 때만 env로 명시 override한다.
process.env.SOCIAL_GOOGLE_ENABLED ??= 'false';
process.env.SOCIAL_KAKAO_ENABLED ??= 'false';
process.env.SOCIAL_NAVER_ENABLED ??= 'false';
process.env.SOCIAL_CALLBACK_BASE_URL ??= 'http://localhost:3000';
process.env.SOCIAL_RETURN_ALLOWLIST ??= 'http://localhost:3111';
process.env.LEGAL_TERMS_VERSION ??= 'v0';
process.env.LEGAL_TERMS_URL ??= 'http://localhost:3111/legal/terms';
process.env.LEGAL_TERMS_EFFECTIVE_AT ??= '2026-07-14';
process.env.LEGAL_PRIVACY_VERSION ??= 'v0';
process.env.LEGAL_PRIVACY_URL ??= 'http://localhost:3111/legal/privacy';
process.env.LEGAL_PRIVACY_EFFECTIVE_AT ??= '2026-07-14';
process.env.LEGAL_PRIVACY_CONTACT_URL ??= 'http://localhost:3111/privacy-contact';
process.env.LEGAL_REMOVAL_GUIDE_URL ??= 'http://localhost:3111/uninstall';
