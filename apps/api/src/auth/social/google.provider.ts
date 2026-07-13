import { IdentityProvider } from '../../entities/identity.entity';
import { ProviderCredentials } from './social.config';
import { OidcProvider } from './oidc.provider';

/**
 * Google OpenID Connect.
 * https://developers.google.com/identity/openid-connect/openid-connect
 * scope는 인증에 필요한 openid만 요청한다(email·profile 미요청 — 수집 최소화).
 */
export class GoogleProvider extends OidcProvider {
  constructor(credentials: ProviderCredentials) {
    super(
      IdentityProvider.GOOGLE,
      {
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
      },
      credentials,
      'openid',
    );
  }
}
