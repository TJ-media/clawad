import { IdentityProvider } from '../../entities/identity.entity';
import { ProviderCredentials } from './social.config';
import { OidcProvider } from './oidc.provider';

/**
 * Kakao 로그인(OIDC). https://developers.kakao.com/docs/ko/kakaologin/rest-api
 * 카카오 개발자 콘솔에서 OpenID Connect 활성화가 선행돼야 id_token이 발급된다.
 * id_token의 aud는 앱 REST API 키(client id)다. scope는 openid만 요청한다.
 */
export class KakaoProvider extends OidcProvider {
  constructor(credentials: ProviderCredentials) {
    super(
      IdentityProvider.KAKAO,
      {
        authorizationEndpoint: 'https://kauth.kakao.com/oauth/authorize',
        tokenEndpoint: 'https://kauth.kakao.com/oauth/token',
        jwksUri: 'https://kauth.kakao.com/.well-known/jwks.json',
        issuer: 'https://kauth.kakao.com',
      },
      credentials,
      'openid',
    );
  }
}
