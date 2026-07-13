import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../common/redis.module';
import { Consent, ConsentType, REQUIRED_CONSENTS } from '../entities/consent.entity';
import { ACTIVE_SOCIAL_PROVIDERS, Identity, IdentityProvider } from '../entities/identity.entity';
import { User, UserStatus } from '../entities/user.entity';
import { AuthService, TokenPair } from './auth.service';
import { ConsentInput, SocialIntent } from './dto';
import { SocialConfig } from './social/social.config';
import { SocialProviderRegistry } from './social/social-provider.registry';

const base64url = (bytes: number) => randomBytes(bytes).toString('base64url');
const stateKey = (state: string) => `auth:social:state:${state}`;
const handoffKey = (code: string) => `auth:social:handoff:${code}`;

interface StateSession {
  provider: IdentityProvider;
  intent: SocialIntent;
  returnTarget: string;
  codeVerifier?: string;
  nonce?: string;
  linkUserId?: string;
}

interface HandoffSession {
  provider: IdentityProvider;
  subject: string;
  intent: SocialIntent;
  linkUserId?: string;
}

export type ExchangeResult =
  | { kind: 'SESSION'; tokens: TokenPair }
  | { kind: 'LINKED'; provider: IdentityProvider }
  | { kind: 'SIGNUP_REQUIRED'; provider: IdentityProvider };

/** PostgreSQL unique_violation. 동시 콜백 경합을 멱등 처리하는 데 쓴다. */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

/**
 * 소셜 전용 인증 오케스트레이션 (CLAW-37).
 * 계정 키는 (provider, providerSubject)다. 이메일·프로필은 식별자로 쓰지 않는다.
 * provider token/secret/subject를 로그·응답·redirect URL에 남기지 않는다.
 */
@Injectable()
export class SocialAuthService {
  private readonly stateTtl: number;
  private readonly handoffTtl: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly auth: AuthService,
    private readonly registry: SocialProviderRegistry,
    private readonly socialConfig: SocialConfig,
    config: ConfigService,
  ) {
    this.stateTtl = Number(config.get<string>('SOCIAL_STATE_TTL_SECONDS', '600'));
    this.handoffTtl = Number(config.get<string>('SOCIAL_HANDOFF_TTL_SECONDS', '120'));
  }

  /** path의 provider 문자열을 활성 공급자 enum으로 변환한다. 비활성·미설정은 거절. */
  private resolveProvider(name: string): IdentityProvider {
    const upper = String(name).toUpperCase();
    const provider = ACTIVE_SOCIAL_PROVIDERS.find((p) => p === upper);
    // EMAIL·GITHUB 등 비활성 공급자는 노출하지 않는다.
    if (!provider) throw new BadRequestException({ error: 'PROVIDER_NOT_SUPPORTED' });
    if (!this.registry.get(provider)) {
      // 활성 목록이지만 이 환경에 client id/secret이 없다.
      throw new BadRequestException({ error: 'PROVIDER_NOT_ENABLED', provider });
    }
    return provider;
  }

  async start(
    providerName: string,
    intent: SocialIntent,
    returnTarget: string,
    linkUserId?: string,
  ): Promise<{ authorizationUrl: string }> {
    const providerEnum = this.resolveProvider(providerName);
    const provider = this.registry.get(providerEnum)!;

    if (!this.socialConfig.isAllowedReturnTarget(returnTarget)) {
      throw new BadRequestException({ error: 'RETURN_TARGET_NOT_ALLOWED' });
    }
    if (intent === 'LINK' && !linkUserId) {
      // 컨트롤러가 Bearer를 확인해 linkUserId를 전달한다. 없으면 계약 위반.
      throw new UnauthorizedException({ error: 'LINK_REQUIRES_AUTH' });
    }

    const state = base64url(32);
    const codeVerifier = provider.supportsPkce ? base64url(32) : undefined;
    const codeChallenge = codeVerifier
      ? createHash('sha256').update(codeVerifier).digest('base64url')
      : undefined;
    const nonce = provider.supportsNonce ? base64url(16) : undefined;

    const session: StateSession = { provider: providerEnum, intent, returnTarget, codeVerifier, nonce, linkUserId };
    await this.redis.set(stateKey(state), JSON.stringify(session), 'EX', this.stateTtl);

    const authorizationUrl = provider.buildAuthorizationUrl({
      redirectUri: this.socialConfig.redirectUri(providerEnum),
      state,
      codeChallenge,
      nonce,
    });
    return { authorizationUrl };
  }

  /**
   * 공급자 콜백 처리. 성공·거절 모두 return target으로의 redirect URL을 반환한다.
   * state가 없거나 무효라 안전한 redirect 대상을 알 수 없으면 예외(JSON 4xx)로 끝낸다 — open redirect 방지.
   */
  async handleCallback(
    providerName: string,
    code: string | undefined,
    state: string | undefined,
    providerError: string | undefined,
  ): Promise<{ redirectUrl: string }> {
    if (!state) throw new BadRequestException({ error: 'INVALID_STATE' });
    const raw = await this.redis.get(stateKey(state));
    if (!raw) throw new UnauthorizedException({ error: 'INVALID_STATE' });
    // state는 1회성이다. 검증 성공·실패와 무관하게 즉시 소비한다.
    await this.redis.del(stateKey(state));
    const session = JSON.parse(raw) as StateSession;

    if (session.provider.toLowerCase() !== String(providerName).toLowerCase()) {
      throw new BadRequestException({ error: 'PROVIDER_MISMATCH' });
    }
    const returnTarget = session.returnTarget;

    // 사용자가 공급자 동의를 취소했거나 code가 없다.
    if (providerError || !code) {
      return { redirectUrl: this.buildReturn(returnTarget, 'error', 'SOCIAL_CANCELED') };
    }

    const provider = this.registry.get(session.provider);
    if (!provider) return { redirectUrl: this.buildReturn(returnTarget, 'error', 'PROVIDER_NOT_ENABLED') };

    let subject: string;
    try {
      ({ subject } = await provider.verify({
        code,
        redirectUri: this.socialConfig.redirectUri(session.provider),
        codeVerifier: session.codeVerifier,
        nonce: session.nonce,
      }));
    } catch {
      // 검증 실패 상세는 노출하지 않는다. 계정·동의·토큰을 만들지 않는다.
      return { redirectUrl: this.buildReturn(returnTarget, 'error', 'SOCIAL_VERIFY_FAILED') };
    }

    const handoff = base64url(32);
    const handoffSession: HandoffSession = {
      provider: session.provider,
      subject,
      intent: session.intent,
      linkUserId: session.linkUserId,
    };
    await this.redis.set(handoffKey(handoff), JSON.stringify(handoffSession), 'EX', this.handoffTtl);
    return { redirectUrl: this.buildReturn(returnTarget, 'code', handoff) };
  }

  /**
   * return target에 결과를 실어 redirect URL을 만든다.
   * - 브라우저(user-web): URL fragment(#)로 전달해 handoff가 서버 로그·referrer에 남지 않게 한다.
   * - CLI loopback(127.0.0.1): fragment는 로컬 서버가 읽을 수 없으므로 query(?)로 전달한다.
   * 어느 경우든 내부 JWT/refresh 토큰은 URL에 넣지 않는다(1회성 handoff code만).
   */
  private buildReturn(returnTarget: string, key: 'code' | 'error', value: string): string {
    const isLoopback = (() => {
      try {
        return new URL(returnTarget).hostname === '127.0.0.1';
      } catch {
        return false;
      }
    })();
    const separator = isLoopback ? (returnTarget.includes('?') ? '&' : '?') : '#';
    return `${returnTarget}${separator}${key}=${encodeURIComponent(value)}`;
  }

  async exchange(handoffCode: string, consents?: ConsentInput[]): Promise<ExchangeResult> {
    const raw = await this.redis.get(handoffKey(handoffCode));
    if (!raw) throw new UnauthorizedException({ error: 'INVALID_HANDOFF_CODE' });
    const handoff = JSON.parse(raw) as HandoffSession;

    if (handoff.intent === 'LINK') {
      if (!handoff.linkUserId) throw new UnauthorizedException({ error: 'INVALID_HANDOFF_CODE' });
      await this.redis.del(handoffKey(handoffCode));
      await this.linkIdentity(handoff.linkUserId, handoff.provider, handoff.subject);
      return { kind: 'LINKED', provider: handoff.provider };
    }

    // LOGIN: 기존 identity면 로그인, 없으면 신규 가입(필수 동의 필요).
    const existing = await this.dataSource.getRepository(Identity).findOne({
      where: { provider: handoff.provider, providerSubject: handoff.subject },
      relations: { user: true },
    });
    if (existing) {
      await this.redis.del(handoffKey(handoffCode));
      if (existing.user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
      }
      return { kind: 'SESSION', tokens: await this.auth.issueSession(existing.userId) };
    }

    if (!this.hasRequiredConsents(consents)) {
      // 신규 가입인데 동의가 없다. handoff를 소비하지 않고 클라이언트에 동의 UI를 요청한다.
      return { kind: 'SIGNUP_REQUIRED', provider: handoff.provider };
    }

    const userId = await this.createUser(handoff.provider, handoff.subject, consents!);
    await this.redis.del(handoffKey(handoffCode));
    return { kind: 'SESSION', tokens: await this.auth.issueSession(userId) };
  }

  private hasRequiredConsents(consents?: ConsentInput[]): boolean {
    if (!consents) return false;
    const granted = new Set(consents.filter((c) => c.granted).map((c) => c.type));
    return REQUIRED_CONSENTS.every((t: ConsentType) => granted.has(t));
  }

  /** 신규 소셜 사용자 생성. email·passwordHash는 NULL. 동시 콜백 경합은 unique 위반으로 멱등 처리. */
  private async createUser(provider: IdentityProvider, subject: string, consents: ConsentInput[]): Promise<string> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const user = await manager.save(manager.create(User, { email: null, status: UserStatus.ACTIVE }));
        await manager.save(
          manager.create(Identity, { userId: user.id, provider, providerSubject: subject, passwordHash: null }),
        );
        await manager.save(
          consents.map((c) =>
            manager.create(Consent, {
              userId: user.id,
              type: c.type,
              granted: c.granted,
              documentVersion: c.documentVersion,
            }),
          ),
        );
        return user.id;
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        // 동시에 같은 (provider, subject)가 생성됐다. 기존 계정으로 귀결시킨다(중복 user 방지).
        const again = await this.dataSource
          .getRepository(Identity)
          .findOne({ where: { provider, providerSubject: subject } });
        if (again) return again.userId;
      }
      throw e;
    }
  }

  /** 로그인된 사용자에 provider identity를 연결한다. 자동 계정 병합은 하지 않는다. */
  private async linkIdentity(userId: string, provider: IdentityProvider, subject: string): Promise<void> {
    const user = await this.dataSource.getRepository(User).findOneBy({ id: userId });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
    }

    const bySubject = await this.dataSource
      .getRepository(Identity)
      .findOne({ where: { provider, providerSubject: subject } });
    if (bySubject) {
      if (bySubject.userId === userId) return; // 같은 사용자·같은 identity 재연결은 멱등.
      // 이 소셜 계정은 다른 사용자에 이미 연결돼 있다. 자동 병합 금지.
      throw new ConflictException({ error: 'IDENTITY_ALREADY_LINKED' });
    }

    const byProvider = await this.dataSource.getRepository(Identity).findOne({ where: { userId, provider } });
    if (byProvider) {
      // 이 사용자는 이미 같은 provider의 다른 계정을 연결했다(UNIQUE(userId, provider)).
      throw new ConflictException({ error: 'PROVIDER_ALREADY_LINKED', provider });
    }

    try {
      await this.dataSource
        .getRepository(Identity)
        .save(this.dataSource.getRepository(Identity).create({ userId, provider, providerSubject: subject, passwordHash: null }));
    } catch (e) {
      // 경합으로 방금 사이에 연결됐다면 제약이 막는다. 멱등·충돌로 정규화.
      if (isUniqueViolation(e)) {
        const again = await this.dataSource
          .getRepository(Identity)
          .findOne({ where: { provider, providerSubject: subject } });
        if (again && again.userId === userId) return;
        throw new ConflictException({ error: 'IDENTITY_ALREADY_LINKED' });
      }
      throw e;
    }
  }

  /** provider identity 연결 해제. 마지막 남은 identity는 해제할 수 없다. */
  async unlinkIdentity(userId: string, providerName: string): Promise<{ removed: boolean; provider: IdentityProvider }> {
    const provider = this.resolveProvider(providerName);

    return this.dataSource.transaction(async (manager) => {
      const identities = await manager.find(Identity, { where: { userId } });
      const target = identities.find((i) => i.provider === provider);
      if (!target) throw new NotFoundException({ error: 'IDENTITY_NOT_FOUND', provider });
      if (identities.length <= 1) {
        throw new ConflictException({ error: 'CANNOT_REMOVE_LAST_IDENTITY' });
      }
      await manager.delete(Identity, { id: target.id });
      return { removed: true, provider };
    });
  }
}
