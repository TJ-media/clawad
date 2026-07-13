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
process.env.ADMIN_JWT_SECRET ??= randomBytes(32).toString('hex');
process.env.ADMIN_TOKEN_TTL ??= '30m';
// 부트스트랩 SUPERADMIN. e2e에서 이 계정으로 로그인해 관리 API를 호출한다.
process.env.ADMIN_BOOTSTRAP_EMAIL ??= 'root@clawad.test';
process.env.ADMIN_BOOTSTRAP_PASSWORD ??= 'bootstrap-superadmin-pw';
