import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';

/**
 * 웹 세션 refresh 토큰 쿠키 (CLAW-38).
 * httpOnly라 JS가 읽을 수 없어 XSS로 탈취되지 않는다. Path를 /v1/auth로 제한해 일반 API 요청에는 실리지 않는다.
 * access 토큰은 쿠키에 넣지 않는다 — 클라이언트가 메모리에만 보관한다.
 */
export const REFRESH_COOKIE = 'clawad_rt';
const COOKIE_PATH = '/v1/auth';

export interface RefreshCookieOptions {
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  domain?: string;
  maxAgeMs: number;
}

/** 쿠키 속성은 환경설정으로 관리한다. 운영은 HTTPS + Secure 필수. */
export function refreshCookieOptions(config: ConfigService): RefreshCookieOptions {
  const secure = config.get<string>('AUTH_COOKIE_SECURE', 'true') !== 'false';
  const sameSite = config.get<string>('AUTH_COOKIE_SAMESITE', 'lax').toLowerCase() as 'lax' | 'strict' | 'none';
  const domain = config.get<string>('AUTH_COOKIE_DOMAIN') || undefined;
  const days = Number(config.get<string>('REFRESH_TOKEN_TTL_DAYS', '30'));
  return { secure, sameSite, domain, maxAgeMs: days * 24 * 60 * 60 * 1000 };
}

/** 요청 헤더에서 refresh 쿠키만 파싱한다(cookie-parser 미도입, 무의존성). */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === REFRESH_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

export function setRefreshCookie(res: Response, token: string, opts: RefreshCookieOptions): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: opts.sameSite,
    domain: opts.domain,
    path: COOKIE_PATH,
    maxAge: opts.maxAgeMs,
  });
}

export function clearRefreshCookie(res: Response, opts: RefreshCookieOptions): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: opts.sameSite,
    domain: opts.domain,
    path: COOKIE_PATH,
  });
}
