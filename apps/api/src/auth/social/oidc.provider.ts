import { UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { IdentityProvider } from '../../entities/identity.entity';
import { ProviderCredentials } from './social.config';
import {
  AuthorizationRequest,
  CallbackVerification,
  SocialProvider,
  VerifiedIdentity,
} from './provider.interface';

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** id_token의 허용 issuer. 문자열 또는 복수 허용. */
  issuer: string | string[];
}

/**
 * OIDC Authorization Code + PKCE(S256) + nonce 공급자 공통 구현(Google·Kakao).
 * id_token을 JWKS/RS256/iss/aud/exp/nonce로 fail-closed 검증하고, payload.sub만 subject로 쓴다.
 */
export abstract class OidcProvider implements SocialProvider {
  readonly supportsPkce = true;
  readonly supportsNonce = true;

  private readonly jwks: JWTVerifyGetKey;

  protected constructor(
    readonly provider: IdentityProvider,
    private readonly endpoints: OidcEndpoints,
    private readonly credentials: ProviderCredentials,
    private readonly scope: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(endpoints.jwksUri));
  }

  buildAuthorizationUrl(req: AuthorizationRequest): string {
    const url = new URL(this.endpoints.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.credentials.clientId);
    url.searchParams.set('redirect_uri', req.redirectUri);
    url.searchParams.set('scope', this.scope);
    url.searchParams.set('state', req.state);
    if (req.codeChallenge) {
      url.searchParams.set('code_challenge', req.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    if (req.nonce) url.searchParams.set('nonce', req.nonce);
    return url.toString();
  }

  async verify(req: CallbackVerification): Promise<VerifiedIdentity> {
    const idToken = await this.exchangeCodeForIdToken(req);
    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(idToken, this.jwks, {
        issuer: this.endpoints.issuer,
        audience: this.credentials.clientId,
        algorithms: ['RS256'],
      });
      payload = verified.payload as Record<string, unknown>;
    } catch {
      // 서명·iss·aud·exp 검증 실패. 토큰 원문·상세는 남기지 않는다.
      throw new UnauthorizedException({ error: 'SOCIAL_TOKEN_INVALID', provider: this.provider });
    }

    if (req.nonce && payload.nonce !== req.nonce) {
      throw new UnauthorizedException({ error: 'SOCIAL_NONCE_MISMATCH', provider: this.provider });
    }
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject) {
      throw new UnauthorizedException({ error: 'SOCIAL_SUBJECT_MISSING', provider: this.provider });
    }
    return { subject };
  }

  private async exchangeCodeForIdToken(req: CallbackVerification): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: req.code,
      redirect_uri: req.redirectUri,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
    });
    if (req.codeVerifier) body.set('code_verifier', req.codeVerifier);

    let response: Response;
    try {
      response = await fetch(this.endpoints.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      });
    } catch {
      // 공급자 장애. 오류에 code/secret을 담지 않는다.
      throw new UnauthorizedException({ error: 'SOCIAL_PROVIDER_UNAVAILABLE', provider: this.provider });
    }
    if (!response.ok) {
      throw new UnauthorizedException({ error: 'SOCIAL_CODE_EXCHANGE_FAILED', provider: this.provider });
    }
    const json = (await response.json().catch(() => ({}))) as { id_token?: unknown };
    if (typeof json.id_token !== 'string' || !json.id_token) {
      throw new UnauthorizedException({ error: 'SOCIAL_ID_TOKEN_MISSING', provider: this.provider });
    }
    return json.id_token;
  }
}
