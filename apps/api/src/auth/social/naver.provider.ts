import { UnauthorizedException } from '@nestjs/common';
import { IdentityProvider } from '../../entities/identity.entity';
import { ProviderCredentials } from './social.config';
import {
  AuthorizationRequest,
  CallbackVerification,
  SocialProvider,
  VerifiedIdentity,
} from './provider.interface';

const AUTHORIZATION_ENDPOINT = 'https://nid.naver.com/oauth2.0/authorize';
const TOKEN_ENDPOINT = 'https://nid.naver.com/oauth2.0/token';
const USERINFO_ENDPOINT = 'https://openapi.naver.com/v1/nid/me';

/**
 * Naver 로그인. https://developers.naver.com/docs/login/devguide/devguide.md
 *
 * 네이버 로그인은 표준 OIDC id_token을 발급하지 않는다 — Authorization Code로 access token을 받고
 * userinfo(/v1/nid/me)의 안정적 `response.id`를 subject로 쓴다. 따라서 PKCE·nonce는 미지원이며
 * state로 요청을 바인딩한다. access token은 subject 조회에만 쓰고 저장하지 않는다.
 */
export class NaverProvider implements SocialProvider {
  readonly provider = IdentityProvider.NAVER;
  readonly supportsPkce = false;
  readonly supportsNonce = false;

  constructor(private readonly credentials: ProviderCredentials) {}

  buildAuthorizationUrl(req: AuthorizationRequest): string {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.credentials.clientId);
    url.searchParams.set('redirect_uri', req.redirectUri);
    url.searchParams.set('state', req.state);
    return url.toString();
  }

  async verify(req: CallbackVerification): Promise<VerifiedIdentity> {
    const accessToken = await this.exchangeCodeForAccessToken(req);
    const subject = await this.fetchSubject(accessToken);
    return { subject };
  }

  private async exchangeCodeForAccessToken(req: CallbackVerification): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      code: req.code,
    });

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      });
    } catch {
      throw new UnauthorizedException({ error: 'SOCIAL_PROVIDER_UNAVAILABLE', provider: this.provider });
    }
    if (!response.ok) {
      throw new UnauthorizedException({ error: 'SOCIAL_CODE_EXCHANGE_FAILED', provider: this.provider });
    }
    const json = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
    if (typeof json.access_token !== 'string' || !json.access_token) {
      throw new UnauthorizedException({ error: 'SOCIAL_CODE_EXCHANGE_FAILED', provider: this.provider });
    }
    return json.access_token;
  }

  private async fetchSubject(accessToken: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
    } catch {
      throw new UnauthorizedException({ error: 'SOCIAL_PROVIDER_UNAVAILABLE', provider: this.provider });
    }
    if (!response.ok) {
      throw new UnauthorizedException({ error: 'SOCIAL_USERINFO_FAILED', provider: this.provider });
    }
    const json = (await response.json().catch(() => ({}))) as {
      resultcode?: unknown;
      response?: { id?: unknown };
    };
    // 네이버는 성공 시 resultcode '00'을 준다. 실패·부분응답은 fail-closed.
    if (json.resultcode !== '00' || !json.response || typeof json.response.id !== 'string' || !json.response.id) {
      throw new UnauthorizedException({ error: 'SOCIAL_USERINFO_FAILED', provider: this.provider });
    }
    return json.response.id;
  }
}
