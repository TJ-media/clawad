import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityProvider } from '../../entities/identity.entity';

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * 소셜 로그인 설정. client id/secret은 환경별 시크릿 매니저로 주입한다(코드·레포에 두지 않음, CLAW-27).
 * 두 값이 모두 있는 공급자만 "활성"으로 취급한다. 미설정 공급자 요청은 상위에서 400으로 거절된다.
 */
@Injectable()
export class SocialConfig {
  constructor(private readonly config: ConfigService) {}

  private envKey(provider: IdentityProvider): string {
    return provider.toUpperCase();
  }

  credentials(provider: IdentityProvider): ProviderCredentials | null {
    const key = this.envKey(provider);
    const enabled = this.config.get<string>(`SOCIAL_${key}_ENABLED`);
    if (enabled === 'false') return null;
    const clientId = this.config.get<string>(`SOCIAL_${key}_CLIENT_ID`);
    const clientSecret = this.config.get<string>(`SOCIAL_${key}_CLIENT_SECRET`);
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  isEnabled(provider: IdentityProvider): boolean {
    return this.credentials(provider) !== null;
  }

  /** 공급자 앱에 등록해야 하는 콜백 redirect_uri. 설정 기반 base URL로만 조립한다. */
  redirectUri(provider: IdentityProvider): string {
    const base = this.config.get<string>('SOCIAL_CALLBACK_BASE_URL');
    if (!base) {
      throw new Error('SOCIAL_CALLBACK_BASE_URL 환경변수가 필요합니다. apps/api/.env.example을 참고하세요.');
    }
    return `${base.replace(/\/+$/, '')}/v1/auth/social/${provider.toLowerCase()}/callback`;
  }

  /** exchange 이후 handoff code를 fragment로 실어보낼 수 있는 허용 return target 목록(정확한 origin). */
  private returnAllowlist(): string[] {
    return (this.config.get<string>('SOCIAL_RETURN_ALLOWLIST') ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  /**
   * return target 검증. 임의 외부 URL redirect를 금지한다(open redirect 방지).
   * - 설정 allowlist의 origin과 정확히 접두 일치하면 허용.
   * - CLI loopback: http이고 host가 127.0.0.1인 경우만 허용(임의 포트·경로).
   */
  isAllowedReturnTarget(target: string): boolean {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return false;
    }
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return true;
    return this.returnAllowlist().some((allowed) => {
      let a: URL;
      try {
        a = new URL(allowed);
      } catch {
        return false;
      }
      return url.origin === a.origin;
    });
  }
}
