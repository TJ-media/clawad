import { IdentityProvider } from '../../entities/identity.entity';

/** 공급자 authorization URL 조립에 필요한 1회성 파라미터. */
export interface AuthorizationRequest {
  /** 이 공급자의 콜백 redirect_uri. 설정 기반 값만 쓴다. */
  redirectUri: string;
  /** 고엔트로피 state. CSRF·요청 바인딩. */
  state: string;
  /** PKCE S256 challenge. supportsPkce인 공급자에만 전달한다. */
  codeChallenge?: string;
  /** OIDC nonce. supportsNonce인 공급자에만 전달한다. */
  nonce?: string;
}

/** 콜백에서 받은 code를 검증·교환할 때 필요한 값. */
export interface CallbackVerification {
  code: string;
  redirectUri: string;
  /** PKCE code_verifier. supportsPkce면 필수. */
  codeVerifier?: string;
  /** start에서 발급한 nonce. supportsNonce면 id_token과 대조한다. */
  nonce?: string;
}

/** 검증 결과. 공급자의 안정적 subject만 노출한다 — 이메일·프로필은 계정 키로 쓰지 않는다. */
export interface VerifiedIdentity {
  subject: string;
}

/**
 * 소셜 로그인 공급자 어댑터. Authorization Code 흐름을 공급자별로 캡슐화한다.
 * 구현체는 code/token/secret/subject를 로그·응답 오류에 남기지 않는다 (CLAW-27, privacy-design §6.5).
 */
export interface SocialProvider {
  readonly provider: IdentityProvider;
  readonly supportsPkce: boolean;
  readonly supportsNonce: boolean;

  buildAuthorizationUrl(req: AuthorizationRequest): string;

  /** code를 검증·교환해 안정적 subject를 반환한다. 어떤 검증이라도 실패하면 예외를 던진다(fail-closed). */
  verify(req: CallbackVerification): Promise<VerifiedIdentity>;
}

/** 공급자 어댑터 목록 DI 토큰. 활성화된 공급자만 등록된다. */
export const SOCIAL_PROVIDERS = 'SOCIAL_PROVIDERS';
