import { randomBytes } from 'node:crypto';

/**
 * e2e 테스트용 환경변수. docker-compose의 로컬 인프라를 가리킨다.
 * 기본 포트(5432/6379)를 쓰지 않으므로 같은 머신의 다른 프로젝트 DB를 건드리지 않는다.
 */
process.env.DB_HOST ??= 'localhost';
process.env.DB_PORT ??= '55432';
process.env.DB_USER ??= 'clawad';
process.env.DB_PASSWORD ??= 'clawad_local_dev';
process.env.DB_NAME ??= 'clawad';
process.env.REDIS_HOST ??= 'localhost';
process.env.REDIS_PORT ??= '56379';
process.env.AUTH_JWT_SECRET ??= randomBytes(32).toString('hex');
process.env.ACCESS_TOKEN_TTL ??= '15m';
process.env.REFRESH_TOKEN_TTL_DAYS ??= '30';
process.env.ADMIN_API_TOKEN ??= randomBytes(32).toString('hex');
process.env.SERVE_TOKEN_SECRET ??= randomBytes(32).toString('hex');
