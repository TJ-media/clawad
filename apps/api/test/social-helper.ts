import { INestApplication } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthService, TokenPair } from '../src/auth/auth.service';
import {
  AuthorizationRequest,
  CallbackVerification,
  SocialProvider,
  VerifiedIdentity,
} from '../src/auth/social/provider.interface';
import { SocialProviderRegistry } from '../src/auth/social/social-provider.registry';
import { Consent, ConsentType } from '../src/entities/consent.entity';
import { ACTIVE_SOCIAL_PROVIDERS, Identity, IdentityProvider } from '../src/entities/identity.entity';
import { User, UserStatus } from '../src/entities/user.entity';

export const REQUIRED_CONSENTS = [
  { type: ConsentType.TERMS_OF_SERVICE, granted: true, documentVersion: 'v0' },
  { type: ConsentType.PRIVACY_POLICY, granted: true, documentVersion: 'v0' },
];

export interface SeededUser extends TokenPair {
  userId: string;
  subject: string;
  provider: IdentityProvider;
}

/**
 * 소셜 사용자 시드. 이메일 signup이 비활성화됐으므로(CLAW-37) 다른 e2e는 이 헬퍼로 사용자를 만든다.
 * 운영과 동일하게 User + Identity(소셜) + 필수 동의를 만들고, 같은 발급 경로로 세션을 준다.
 */
export async function seedUser(
  app: INestApplication,
  provider: IdentityProvider = IdentityProvider.GOOGLE,
): Promise<SeededUser> {
  const dataSource = app.get<DataSource>(getDataSourceToken());
  const auth = app.get(AuthService);
  const subject = `sub-${randomUUID()}`;

  const userId = await dataSource.transaction(async (manager) => {
    const user = await manager.save(manager.create(User, { email: null, status: UserStatus.ACTIVE }));
    await manager.save(manager.create(Identity, { userId: user.id, provider, providerSubject: subject, passwordHash: null }));
    await manager.save(
      REQUIRED_CONSENTS.map((c) =>
        manager.create(Consent, { userId: user.id, type: c.type, granted: c.granted, documentVersion: c.documentVersion }),
      ),
    );
    return user.id;
  });

  const tokens = await auth.issueSession(userId);
  return { userId, subject, provider, ...tokens };
}

/**
 * 실제 공급자에 접속하지 않는 mock 어댑터. verify는 콜백의 `code`를 그대로 subject로 돌려준다.
 * 테스트가 code에 원하는 subject를 실어보내 결정적으로 identity를 제어한다.
 * 공급자별 실제 능력(PKCE·nonce)을 반영해 nonce 미지원(Naver) 경로도 검증한다.
 */
export class FakeSocialProvider implements SocialProvider {
  constructor(
    readonly provider: IdentityProvider,
    readonly supportsPkce: boolean,
    readonly supportsNonce: boolean,
  ) {}

  buildAuthorizationUrl(req: AuthorizationRequest): string {
    const url = new URL(`https://fake-idp.test/${this.provider.toLowerCase()}/authorize`);
    url.searchParams.set('redirect_uri', req.redirectUri);
    url.searchParams.set('state', req.state);
    if (req.codeChallenge) url.searchParams.set('code_challenge', req.codeChallenge);
    if (req.nonce) url.searchParams.set('nonce', req.nonce);
    return url.toString();
  }

  async verify(req: CallbackVerification): Promise<VerifiedIdentity> {
    if (req.code === '__FAIL__') {
      throw new Error('forced provider failure');
    }
    return { subject: req.code };
  }
}

/** 세 공급자를 실제 능력대로 mock한 레지스트리. e2e에서 SocialProviderRegistry를 이걸로 override한다. */
export function makeFakeRegistry(): SocialProviderRegistry {
  return new SocialProviderRegistry([
    new FakeSocialProvider(IdentityProvider.GOOGLE, true, true),
    new FakeSocialProvider(IdentityProvider.KAKAO, true, true),
    new FakeSocialProvider(IdentityProvider.NAVER, false, false),
  ]);
}

const stateOf = (authorizationUrl: string): string =>
  new URL(authorizationUrl).searchParams.get('state') ?? '';

const handoffOf = (location: string): string => {
  const hash = new URL(location).hash; // '#code=...' 또는 '#error=...'
  return new URLSearchParams(hash.slice(1)).get('code') ?? '';
};

const errorOf = (location: string): string =>
  new URLSearchParams(new URL(location).hash.slice(1)).get('error') ?? '';

export interface DrivenCallback {
  handoffCode: string;
  errorCode: string;
  location: string;
}

/** start → callback까지 구동해 handoff code(또는 error)를 얻는다. LINK는 accessToken을 넘긴다. */
export async function driveSocialLogin(
  app: INestApplication,
  provider: IdentityProvider,
  subject: string,
  opts: { intent?: 'LOGIN' | 'LINK'; returnTarget?: string; accessToken?: string } = {},
): Promise<DrivenCallback> {
  const server = app.getHttpServer();
  const intent = opts.intent ?? 'LOGIN';
  const returnTarget = opts.returnTarget ?? 'http://localhost:3111/auth/callback';
  const path = provider.toLowerCase();

  const startReq = request(server).post(`/v1/auth/social/${path}/start`).send({ intent, returnTarget });
  if (opts.accessToken) startReq.set('Authorization', `Bearer ${opts.accessToken}`);
  const started = await startReq.expect(200);
  const state = stateOf(started.body.authorizationUrl);

  const cb = await request(server).get(`/v1/auth/social/${path}/callback`).query({ code: subject, state });
  const location = cb.headers.location as string;
  return { handoffCode: handoffOf(location), errorCode: errorOf(location), location };
}

/** 신규 소셜 로그인 전체 플로우(동의 포함)로 세션 토큰을 얻는다. */
export async function socialSignupAndLogin(
  app: INestApplication,
  provider: IdentityProvider,
  subject: string,
): Promise<TokenPair> {
  const { handoffCode } = await driveSocialLogin(app, provider, subject);
  const res = await request(app.getHttpServer())
    .post('/v1/auth/social/exchange')
    .send({ handoffCode, consents: REQUIRED_CONSENTS })
    .expect(200);
  return res.body as TokenPair;
}

export { ACTIVE_SOCIAL_PROVIDERS, IdentityProvider };
