import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { readFileSync } from 'node:fs';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** 모니터 전용 장기 난수 토큰. 토큰 원문은 비교 외 용도로 사용하지 않는다. */
@Injectable()
export class MonitoringTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  private expectedToken(): string | null {
    const file = this.config.get<string>('MONITORING_TOKEN_FILE', '/run/secrets/monitoring_token');
    try {
      const value = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      if (Buffer.byteLength(value, 'utf8') >= 32) return value;
    } catch {
      // 운영은 파일 시크릿만 허용한다. 파일 경로나 오류 상세는 로그·응답에 남기지 않는다.
    }
    if (process.env.NODE_ENV === 'production') return null;
    const fallback = this.config.get<string>('MONITORING_TOKEN')?.trim();
    return fallback && Buffer.byteLength(fallback, 'utf8') >= 32 ? fallback : null;
  }

  canActivate(context: ExecutionContext): boolean {
    const expected = this.expectedToken();
    if (!expected) {
      throw new ServiceUnavailableException({ error: 'MONITORING_NOT_CONFIGURED' });
    }
    const req = context.switchToHttp().getRequest<Request>();
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ error: 'MONITORING_TOKEN_REQUIRED' });
    }
    const actual = authorization.slice(7);
    if (!timingSafeEqual(digest(actual), digest(expected))) {
      throw new UnauthorizedException({ error: 'MONITORING_TOKEN_INVALID' });
    }
    return true;
  }
}
