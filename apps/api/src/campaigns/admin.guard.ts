import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

/**
 * 운영자 콘솔용 내부 API 보호. **임시 조치다.**
 * 정식 관리자 권한·역할·감사로그는 CLAW-27 범위이며, 이 가드는 그때 교체한다.
 *
 * 공개 fallback을 두지 않는다 — ADMIN_API_TOKEN이 없으면 모든 요청을 거절한다.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('ADMIN_API_TOKEN');
    if (!expected || expected.length < 32) {
      throw new UnauthorizedException({ error: 'ADMIN_API_NOT_CONFIGURED' });
    }

    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-clawad-admin-token'];
    if (typeof provided !== 'string') throw new UnauthorizedException({ error: 'ADMIN_TOKEN_REQUIRED' });

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // 토큰 값을 로그·응답에 남기지 않는다 (privacy-design.md §6.5).
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({ error: 'ADMIN_TOKEN_INVALID' });
    }
    return true;
  }
}
