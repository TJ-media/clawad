import './setup-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/common/redis.module';

/**
 * CLAW-176 rate limit. 다른 스펙은 setup-env.ts가 RATE_LIMIT_ENABLED='false'로 끄므로,
 * 이 스펙만 자체적으로 켜서 관리자 로그인 무차별 대입이 429로 막히는지 검증하고, 끝나면 되돌린다.
 */
describe('CLAW-176 rate limit (e2e)', () => {
  let app: INestApplication;
  let redis: Redis;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    redis = app.get<Redis>(REDIS_CLIENT);
    // 이전 실행의 잔여 카운터를 지워 창을 깨끗이 시작한다.
    const stale = await redis.keys('ratelimit:*');
    if (stale.length) await redis.del(...stale);
  });

  afterAll(async () => {
    const keys = await redis.keys('ratelimit:*');
    if (keys.length) await redis.del(...keys);
    process.env.RATE_LIMIT_ENABLED = 'false';
    await app.close();
  });

  const api = () => request(app.getHttpServer());

  it('관리자 로그인은 분당 10회를 넘기면 429로 막힌다', async () => {
    const creds = { email: 'ratelimit-probe@clawad.test', password: 'wrong-password' };
    // 1~10회: 자격증명이 틀려 401이지만 rate limit은 통과한다.
    for (let i = 0; i < 10; i += 1) {
      await api().post('/admin/v1/auth/login').send(creds).expect(401);
    }
    // 11회째: 한도 초과로 429.
    const blocked = await api().post('/admin/v1/auth/login').send(creds).expect(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
  });

  it('@RateLimit이 없는 라우트는 제한되지 않는다', async () => {
    // health 등 데코레이션 없는 라우트는 전역 가드가 통과시킨다. 존재하는 공개 라우트로 확인한다.
    for (let i = 0; i < 15; i += 1) {
      const res = await api().get('/health/live');
      expect(res.status).not.toBe(429);
    }
  });
});
