import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.module';

/**
 * 라우트별 rate limit 설정 (CLAW-176). 관리자 로그인 무차별 대입·인증 엔드포인트 자원 소모 공격을
 * 막는다. 값(limit·windowSec)은 라우트 보안 파라미터이며 리워드 정책값이 아니다(규칙 §5 무관).
 */
export interface RateLimitOptions {
  /** 창(windowSec) 안에서 허용하는 최대 요청 수. */
  limit: number;
  /** 창 길이(초). 카운터 TTL이기도 하다. */
  windowSec: number;
  /** 로그인처럼 계정 단위 무차별 대입도 막아야 하면 body.email로도 센다. */
  byEmail?: boolean;
}

export const RATE_LIMIT_KEY = 'clawad:rate-limit';

/** 라우트/핸들러에 IP(옵션으로 이메일) 기준 고정 창 rate limit을 건다. */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 전역 스위치. 기본은 켜짐 — e2e는 setup-env.ts가 'false'로 끄고, rate-limit 전용 스펙만 켠다.
    if (process.env.RATE_LIMIT_ENABLED === 'false') return true;

    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // @RateLimit이 붙지 않은 라우트는 그대로 통과시킨다(전역 가드지만 데코레이션된 곳만 제한).
    if (!options) return true;

    const req = context.switchToHttp().getRequest<Request>();
    // trust proxy=1이라 req.ip는 프록시 한 홉 너머 실제 클라이언트 IP다. rate limit 전용으로만 쓰고
    // 이벤트 원장·로그에 남기지 않으며 windowSec TTL로 즉시 만료시킨다 (privacy-design.md §6.6).
    const ip = req.ip ?? 'unknown';
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const buckets = [`ratelimit:${route}:ip:${ip}`];
    if (options.byEmail) {
      const body = req.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.toLowerCase().slice(0, 320) : '';
      if (email) buckets.push(`ratelimit:${route}:email:${email}`);
    }

    for (const key of buckets) {
      const count = await this.redis.incr(key);
      // 창의 첫 요청에서만 TTL을 건다(고정 창). 이후 요청은 같은 창을 공유하고 창이 끝나면 리셋된다.
      if (count === 1) await this.redis.expire(key, options.windowSec);
      if (count > options.limit) {
        throw new HttpException(
          { error: 'RATE_LIMITED', message: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', retryAfterSec: options.windowSec },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }
}
