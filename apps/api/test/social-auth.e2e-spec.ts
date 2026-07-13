import './setup-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { SocialProviderRegistry } from '../src/auth/social/social-provider.registry';
import { Identity, IdentityProvider } from '../src/entities/identity.entity';
import {
  REQUIRED_CONSENTS,
  driveSocialLogin,
  makeFakeRegistry,
  socialSignupAndLogin,
} from './social-helper';

const decodeSub = (accessToken: string): string =>
  JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).sub;

const newSubject = () => `sub-${randomUUID()}`;

describe('CLAW-37 소셜 전용 인증 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // 실제 Google/Kakao/Naver에 접속하지 않는다 — mock 어댑터로 대체.
      .overrideProvider(SocialProviderRegistry)
      .useValue(makeFakeRegistry())
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
  });

  afterAll(async () => {
    await app.close();
  });

  const identitiesOf = (userId: string) => dataSource.getRepository(Identity).find({ where: { userId } });

  describe('로그인·가입', () => {
    it.each([IdentityProvider.GOOGLE, IdentityProvider.KAKAO, IdentityProvider.NAVER])(
      '%s 최초 로그인·재로그인은 같은 (provider, subject)를 같은 userId로 귀결시킨다',
      async (provider) => {
        const subject = newSubject();
        const first = await socialSignupAndLogin(app, provider, subject);
        const firstUserId = decodeSub(first.accessToken);
        expect(first.refreshToken).toContain('.');

        // 재로그인: 이미 identity가 있으므로 동의 없이도 로그인된다.
        const { handoffCode } = await driveSocialLogin(app, provider, subject);
        const relogin = await request(server()).post('/v1/auth/social/exchange').send({ handoffCode }).expect(200);
        expect(decodeSub(relogin.body.accessToken)).toBe(firstUserId);
      },
    );

    it('신규 사용자는 필수 동의 없이 교환하면 SIGNUP_REQUIRED이며 계정을 만들지 않는다', async () => {
      const subject = newSubject();
      const { handoffCode } = await driveSocialLogin(app, IdentityProvider.GOOGLE, subject);

      const need = await request(server()).post('/v1/auth/social/exchange').send({ handoffCode }).expect(200);
      expect(need.body.signupRequired).toBe(true);
      expect(await dataSource.getRepository(Identity).findOne({ where: { provider: IdentityProvider.GOOGLE, providerSubject: subject } })).toBeNull();

      // handoff는 소비되지 않았으므로 동의를 붙여 재시도하면 가입된다.
      const done = await request(server())
        .post('/v1/auth/social/exchange')
        .send({ handoffCode, consents: REQUIRED_CONSENTS })
        .expect(200);
      expect(done.body.accessToken).toBeTruthy();
    });

    it('이메일이 같아도 서로 다른 provider identity는 자동 병합되지 않는다', async () => {
      // 소셜 subject만 계정 키다. 이메일은 계정 식별에 쓰지 않는다.
      const g = await socialSignupAndLogin(app, IdentityProvider.GOOGLE, newSubject());
      const k = await socialSignupAndLogin(app, IdentityProvider.KAKAO, newSubject());
      expect(decodeSub(g.accessToken)).not.toBe(decodeSub(k.accessToken));
    });
  });

  describe('보안 거절 (fail-closed)', () => {
    it('변조된 state는 401이며 계정·핸드오프를 만들지 않는다', async () => {
      await request(server())
        .get('/v1/auth/social/google/callback')
        .query({ code: newSubject(), state: 'tampered-state-value' })
        .expect(401);
    });

    it('state 없는 콜백은 400', async () => {
      await request(server()).get('/v1/auth/social/google/callback').query({ code: newSubject() }).expect(400);
    });

    it('공급자 검증 실패는 error fragment로 redirect하고 handoff를 만들지 않는다', async () => {
      const { errorCode, handoffCode } = await driveSocialLogin(app, IdentityProvider.GOOGLE, '__FAIL__');
      expect(errorCode).toBe('SOCIAL_VERIFY_FAILED');
      expect(handoffCode).toBe('');
    });

    it('만료·무효 handoff code는 401', async () => {
      await request(server()).post('/v1/auth/social/exchange').send({ handoffCode: 'nope-not-a-real-code' }).expect(401);
    });

    it('handoff code는 1회성이다 — 재사용은 401', async () => {
      const subject = newSubject();
      const { handoffCode } = await driveSocialLogin(app, IdentityProvider.GOOGLE, subject);
      await request(server()).post('/v1/auth/social/exchange').send({ handoffCode, consents: REQUIRED_CONSENTS }).expect(200);
      await request(server()).post('/v1/auth/social/exchange').send({ handoffCode, consents: REQUIRED_CONSENTS }).expect(401);
    });

    it('허용되지 않은 return target은 400', async () => {
      await request(server())
        .post('/v1/auth/social/google/start')
        .send({ intent: 'LOGIN', returnTarget: 'https://evil.example.com/steal' })
        .expect(400);
    });

    it('비활성 공급자(email·github)는 400 PROVIDER_NOT_SUPPORTED', async () => {
      for (const p of ['email', 'github']) {
        const res = await request(server()).post(`/v1/auth/social/${p}/start`).send({ intent: 'LOGIN', returnTarget: 'http://localhost:3111/cb' }).expect(400);
        expect(res.body.error).toBe('PROVIDER_NOT_SUPPORTED');
      }
    });
  });

  describe('동시성', () => {
    it('동일 state의 동시 콜백은 정확히 하나만 handoff를 만든다', async () => {
      const subject = newSubject();
      const started = await request(server())
        .post('/v1/auth/social/google/start')
        .send({ intent: 'LOGIN', returnTarget: 'http://localhost:3111/auth/callback' })
        .expect(200);
      const state = new URL(started.body.authorizationUrl).searchParams.get('state');

      const [a, b] = await Promise.all([
        request(server()).get('/v1/auth/social/google/callback').query({ code: subject, state }),
        request(server()).get('/v1/auth/social/google/callback').query({ code: subject, state }),
      ]);

      expect([a.status, b.status].sort()).toEqual([302, 401]);
      const success = a.status === 302 ? a : b;
      expect(new URL(success.headers.location as string).hash).toContain('code=');
    });

    it('동일 handoff code의 동시 최종 교환은 정확히 하나만 성공한다', async () => {
      const subject = newSubject();
      const { handoffCode } = await driveSocialLogin(app, IdentityProvider.GOOGLE, subject);

      const [a, b] = await Promise.all([
        request(server()).post('/v1/auth/social/exchange').send({ handoffCode, consents: REQUIRED_CONSENTS }),
        request(server()).post('/v1/auth/social/exchange').send({ handoffCode, consents: REQUIRED_CONSENTS }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 401]);
      const rows = await dataSource.getRepository(Identity).find({
        where: { provider: IdentityProvider.GOOGLE, providerSubject: subject },
      });
      expect(rows).toHaveLength(1);
    });

    it('같은 subject의 동시 최초 로그인에서도 중복 user가 생기지 않는다', async () => {
      const subject = newSubject();
      const a = await driveSocialLogin(app, IdentityProvider.KAKAO, subject);
      const b = await driveSocialLogin(app, IdentityProvider.KAKAO, subject);

      const [ra, rb] = await Promise.all([
        request(server()).post('/v1/auth/social/exchange').send({ handoffCode: a.handoffCode, consents: REQUIRED_CONSENTS }),
        request(server()).post('/v1/auth/social/exchange').send({ handoffCode: b.handoffCode, consents: REQUIRED_CONSENTS }),
      ]);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      expect(decodeSub(ra.body.accessToken)).toBe(decodeSub(rb.body.accessToken));

      const rows = await dataSource.getRepository(Identity).find({ where: { provider: IdentityProvider.KAKAO, providerSubject: subject } });
      expect(rows).toHaveLength(1);
    });
  });

  describe('계정 연결 (LINK)', () => {
    it('LINK는 userId를 유지하며 다른 provider를 연결한다', async () => {
      const user = await socialSignupAndLogin(app, IdentityProvider.GOOGLE, newSubject());
      const userId = decodeSub(user.accessToken);

      const { handoffCode } = await driveSocialLogin(app, IdentityProvider.KAKAO, newSubject(), {
        intent: 'LINK',
        accessToken: user.accessToken,
      });
      const linked = await request(server()).post('/v1/auth/social/exchange').send({ handoffCode }).expect(200);
      expect(linked.body.linked).toBe(true);

      const identities = await identitiesOf(userId);
      expect(identities.map((i) => i.provider).sort()).toEqual([IdentityProvider.GOOGLE, IdentityProvider.KAKAO].sort());
    });

    it('LINK에 Bearer가 없으면 401', async () => {
      await request(server())
        .post('/v1/auth/social/kakao/start')
        .send({ intent: 'LINK', returnTarget: 'http://localhost:3111/cb' })
        .expect(401);
    });

    it('다른 사용자가 소유한 identity 연결은 409 IDENTITY_ALREADY_LINKED', async () => {
      const owner = await socialSignupAndLogin(app, IdentityProvider.NAVER, newSubject());
      const ownerSubjectRow = (await identitiesOf(decodeSub(owner.accessToken))).find((i) => i.provider === IdentityProvider.NAVER)!;

      const other = await socialSignupAndLogin(app, IdentityProvider.GOOGLE, newSubject());
      const { handoffCode } = await driveSocialLogin(app, IdentityProvider.NAVER, ownerSubjectRow.providerSubject, {
        intent: 'LINK',
        accessToken: other.accessToken,
      });
      const res = await request(server()).post('/v1/auth/social/exchange').send({ handoffCode }).expect(409);
      expect(res.body.error).toBe('IDENTITY_ALREADY_LINKED');
    });

    it('사용자당 동일 provider 중복 연결은 409 PROVIDER_ALREADY_LINKED', async () => {
      const user = await socialSignupAndLogin(app, IdentityProvider.GOOGLE, newSubject());
      const { handoffCode } = await driveSocialLogin(app, IdentityProvider.GOOGLE, newSubject(), {
        intent: 'LINK',
        accessToken: user.accessToken,
      });
      const res = await request(server()).post('/v1/auth/social/exchange').send({ handoffCode }).expect(409);
      expect(res.body.error).toBe('PROVIDER_ALREADY_LINKED');
    });
  });

  describe('연결 해제 (unlink)', () => {
    it('마지막 identity는 해제할 수 없다 (409)', async () => {
      const user = await socialSignupAndLogin(app, IdentityProvider.GOOGLE, newSubject());
      const res = await request(server())
        .delete('/v1/me/identities/google')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(409);
      expect(res.body.error).toBe('CANNOT_REMOVE_LAST_IDENTITY');
    });

    it('두 개 이상이면 재인증된 세션에서 해제된다', async () => {
      const user = await socialSignupAndLogin(app, IdentityProvider.GOOGLE, newSubject());
      const userId = decodeSub(user.accessToken);
      const { handoffCode } = await driveSocialLogin(app, IdentityProvider.KAKAO, newSubject(), {
        intent: 'LINK',
        accessToken: user.accessToken,
      });
      await request(server()).post('/v1/auth/social/exchange').send({ handoffCode }).expect(200);

      await request(server()).delete('/v1/me/identities/kakao').set('Authorization', `Bearer ${user.accessToken}`).expect(200);

      const remaining = await identitiesOf(userId);
      expect(remaining.map((i) => i.provider)).toEqual([IdentityProvider.GOOGLE]);
    });

    it('토큰 없이 연결 해제는 401', async () => {
      await request(server()).delete('/v1/me/identities/google').expect(401);
    });
  });

  describe('웹 세션 쿠키 (CLAW-38)', () => {
    const setCookies = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const rtSetCookie = (res: request.Response) => setCookies(res).find((c) => c.startsWith('clawad_rt='));
    const rtValue = (setCookie: string) => setCookie.split(';')[0].slice('clawad_rt='.length);

    const webLogin = async (provider: IdentityProvider) => {
      const { handoffCode } = await driveSocialLogin(app, provider, newSubject());
      return request(server())
        .post('/v1/auth/social/exchange')
        .send({ handoffCode, consents: REQUIRED_CONSENTS, useCookie: true })
        .expect(200);
    };

    it('useCookie 교환은 refresh를 httpOnly 쿠키로 주고 본문엔 refreshToken을 담지 않는다', async () => {
      const res = await webLogin(IdentityProvider.GOOGLE);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeUndefined();
      const cookie = rtSetCookie(res);
      expect(cookie).toBeTruthy();
      expect(cookie!.toLowerCase()).toContain('httponly');
      expect(cookie).toContain('Path=/v1/auth');
    });

    it('쿠키로 refresh하면 회전되고 본문엔 accessToken만, 이전 쿠키는 무효', async () => {
      const login = await webLogin(IdentityProvider.KAKAO);
      const cookie1 = rtValue(rtSetCookie(login)!);

      const refreshed = await request(server())
        .post('/v1/auth/refresh')
        .set('Cookie', `clawad_rt=${cookie1}`)
        .send({})
        .expect(200);
      expect(refreshed.body.accessToken).toBeTruthy();
      expect(refreshed.body.refreshToken).toBeUndefined();
      const cookie2 = rtValue(rtSetCookie(refreshed)!);
      expect(cookie2).not.toBe(cookie1);

      // 회전된 이전 쿠키 재사용은 거절(회전 규칙 유지)
      await request(server()).post('/v1/auth/refresh').set('Cookie', `clawad_rt=${cookie1}`).send({}).expect(401);
    });

    it('동일 refresh 쿠키를 동시에 회전하면 정확히 한 요청만 성공한다', async () => {
      const login = await webLogin(IdentityProvider.KAKAO);
      const cookie = rtValue(rtSetCookie(login)!);

      const [a, b] = await Promise.all([
        request(server()).post('/v1/auth/refresh').set('Cookie', `clawad_rt=${cookie}`).send({}),
        request(server()).post('/v1/auth/refresh').set('Cookie', `clawad_rt=${cookie}`).send({}),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 401]);
      const success = a.status === 200 ? a : b;
      expect(success.body.accessToken).toBeTruthy();
      expect(rtSetCookie(success)).toBeTruthy();
    });

    it('쿠키도 본문도 없으면 refresh는 401', async () => {
      await request(server()).post('/v1/auth/refresh').send({}).expect(401);
    });

    it('logout은 refresh를 폐기하고 쿠키를 만료시킨다', async () => {
      const login = await webLogin(IdentityProvider.NAVER);
      const cookie = rtValue(rtSetCookie(login)!);

      const out = await request(server()).post('/v1/auth/logout').set('Cookie', `clawad_rt=${cookie}`).send({}).expect(204);
      expect(rtSetCookie(out)).toBeTruthy(); // clearCookie가 만료 Set-Cookie를 내려준다
      await request(server()).post('/v1/auth/refresh').set('Cookie', `clawad_rt=${cookie}`).send({}).expect(401);
    });

    it('본문(CLI) 모드는 그대로 — 쿠키 없이 본문 refreshToken으로 회전', async () => {
      const { handoffCode } = await driveSocialLogin(app, IdentityProvider.GOOGLE, newSubject());
      const login = await request(server())
        .post('/v1/auth/social/exchange')
        .send({ handoffCode, consents: REQUIRED_CONSENTS })
        .expect(200);
      expect(login.body.refreshToken).toContain('.');
      expect(setCookies(login)).toHaveLength(0);

      const rotated = await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: login.body.refreshToken })
        .expect(200);
      expect(rotated.body.refreshToken).toBeTruthy();
    });
  });
});
