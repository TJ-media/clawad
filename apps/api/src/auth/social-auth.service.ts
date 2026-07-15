import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';
import { REDIS_CLIENT } from '../common/redis.module';
import { Consent, ConsentType, REQUIRED_CONSENTS } from '../entities/consent.entity';
import { ACTIVE_SOCIAL_PROVIDERS, Identity, IdentityProvider } from '../entities/identity.entity';
import { User, UserStatus } from '../entities/user.entity';
import { LegalDocumentsService } from '../legal/legal-documents.service';
import { AuthService, TokenPair } from './auth.service';
import { ConsentInput, SocialIntent } from './dto';
import { SocialConfig } from './social/social.config';
import { SocialProviderRegistry } from './social/social-provider.registry';
import { SocialMetricsService } from './social/social-metrics.service';

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
  | { kind: 'SIGNUP_REQUIRED'; provider: IdentityProvider }
  | { kind: 'CONSENT_REQUIRED'; provider: IdentityProvider };

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
    private readonly metrics: SocialMetricsService,
    private readonly legal: LegalDocumentsService,
    config: ConfigService,
  ) {
    this.stateTtl = Number(config.get<string>('SOCIAL_STATE_TTL_SECONDS', '600'));
    this.handoffTtl = Number(config.get<string>('SOCIAL_HANDOFF_TTL_SECONDS', '120'));
  }

  private verificationError(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response !== null) {
        const code = (response as { error?: unknown }).error;
        if (typeof code === 'string' && /^SOCIAL_[A-Z_]+$/.test(code)) return code;
      }
    }
    return 'SOCIAL_VERIFY_FAILED';
  }

  /** 운영 집계에는 예외 메시지 대신 응답의 고정 대문자 code만 사용한다. */
  private operationalError(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response !== null) {
        const code = (response as { error?: unknown }).error;
        if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
      }
    }
    return 'OTHER';
  }

  /** path를 고정된 지원 provider enum으로만 변환한다. 동적 문자열은 metric label로 쓰지 않는다. */
  private supportedProvider(name: string): IdentityProvider {
    const upper = String(name).toUpperCase();
    const provider = ACTIVE_SOCIAL_PROVIDERS.find((p) => p === upper);
    // EMAIL·GITHUB 등 비활성 공급자는 노출하지 않는다.
    if (!provider) throw new BadRequestException({ error: 'PROVIDER_NOT_SUPPORTED' });
    return provider;
  }

  /** 지원 provider 중 이 환경에 실제로 활성화된 어댑터만 반환한다. */
  private resolveProvider(name: string): IdentityProvider {
    const provider = this.supportedProvider(name);
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
    // 인식 불가능한 동적 문자열은 label로 만들지 않는다. 지원 provider로 정규화된 뒤의
    // 비활성·오구성은 start 실패 metric에 반드시 남긴다.
    const providerEnum = this.supportedProvider(providerName);
    try {
      const provider = this.registry.get(providerEnum);
      if (!provider) {
        throw new BadRequestException({ error: 'PROVIDER_NOT_ENABLED', provider: providerEnum });
      }
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
      await this.metrics.recordPhase(providerEnum, 'start', 'SUCCESS');
      return { authorizationUrl };
    } catch (error) {
      await this.metrics.recordPhase(providerEnum, 'start', this.operationalError(error));
      throw error;
    }
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
    // state는 성공·실패와 무관하게 최초 콜백 하나만 소비한다(CLAW-41).
    const raw = await this.redis.getdel(stateKey(state));
    if (!raw) throw new UnauthorizedException({ error: 'INVALID_STATE' });
    const session = JSON.parse(raw) as StateSession;

    if (session.provider.toLowerCase() !== String(providerName).toLowerCase()) {
      await this.metrics.recordPhase(session.provider, 'callback', 'PROVIDER_MISMATCH');
      throw new BadRequestException({ error: 'PROVIDER_MISMATCH' });
    }
    const returnTarget = session.returnTarget;

    // 사용자가 공급자 동의를 취소했거나 code가 없다.
    if (providerError || !code) {
      await this.metrics.record(session.provider, 'CANCELED');
      await this.metrics.recordPhase(session.provider, 'callback', 'CANCELED');
      return { redirectUrl: this.buildReturn(returnTarget, 'error', 'SOCIAL_CANCELED') };
    }

    const provider = this.registry.get(session.provider);
    if (!provider) {
      await this.metrics.recordPhase(session.provider, 'callback', 'PROVIDER_NOT_ENABLED');
      return { redirectUrl: this.buildReturn(returnTarget, 'error', 'PROVIDER_NOT_ENABLED') };
    }

    let subject: string;
    try {
      ({ subject } = await provider.verify({
        code,
        redirectUri: this.socialConfig.redirectUri(session.provider),
        codeVerifier: session.codeVerifier,
        nonce: session.nonce,
      }));
    } catch (error) {
      const errorCode = this.verificationError(error);
      await this.metrics.record(session.provider, errorCode);
      await this.metrics.recordPhase(session.provider, 'callback', errorCode);
      // 검증 실패 상세는 노출하지 않는다. 계정·동의·토큰을 만들지 않는다.
      return { redirectUrl: this.buildReturn(returnTarget, 'error', 'SOCIAL_VERIFY_FAILED') };
    }

    await this.metrics.record(session.provider, 'SUCCESS');
    await this.metrics.recordPhase(session.provider, 'callback', 'SUCCESS');

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
    const key = handoffKey(handoffCode);
    const initialRaw = await this.redis.get(key);
    if (!initialRaw) throw new UnauthorizedException({ error: 'INVALID_HANDOFF_CODE' });
    const initial = JSON.parse(initialRaw) as HandoffSession;
    if (initial.intent === 'LINK') {
      try {
        if (!initial.linkUserId) throw new UnauthorizedException({ error: 'INVALID_HANDOFF_CODE' });
        const result = await this.legal.withPolicyReadLock(async (manager) => {
          if (await this.legal.userNeedsCurrentConsents(initial.linkUserId!, manager)) {
            throw new UnauthorizedException({ error: 'CONSENT_REQUIRED' });
          }
          await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
            `clawad:identity:${initial.provider}:${initial.subject}`,
          ]);
          await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
            `clawad:user-provider:${initial.linkUserId}:${initial.provider}`,
          ]);
          const raw = await this.redis.getdel(key);
          if (!raw) throw new UnauthorizedException({ error: 'INVALID_HANDOFF_CODE' });
          const handoff = JSON.parse(raw) as HandoffSession;
          await this.linkIdentity(manager, initial.linkUserId!, handoff.provider, handoff.subject);
          return { kind: 'LINKED' as const, provider: handoff.provider };
        });
        await this.metrics.recordPhase(initial.provider, 'exchange', 'SUCCESS');
        return result;
      } catch (error) {
        await this.metrics.recordPhase(initial.provider, 'exchange', this.operationalError(error));
        throw error;
      }
    }

    try {
      const decision: ExchangeResult | { kind: 'ISSUE_SESSION'; userId: string; legalFingerprint: string } =
        await this.legal.withPolicyReadLock(async (manager) => {
          const previewRaw = await this.redis.get(key);
          if (!previewRaw) throw new UnauthorizedException({ error: 'INVALID_HANDOFF_CODE' });
          const preview = JSON.parse(previewRaw) as HandoffSession;

          let existing: Identity | null = null;
          const active = await this.legal.activeDocuments(manager);
          if (preview.intent === 'LOGIN') {
            await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
              `clawad:identity:${preview.provider}:${preview.subject}`,
            ]);
            existing = await manager.getRepository(Identity).findOne({
              where: { provider: preview.provider, providerSubject: preview.subject },
              relations: { user: true },
            });
            if (!existing) {
              if (!consents) return { kind: 'SIGNUP_REQUIRED', provider: preview.provider };
              this.validateRequiredConsents(consents, active);
            } else if (await this.legal.userNeedsCurrentConsents(existing.userId, manager)) {
              if (!consents) return { kind: 'CONSENT_REQUIRED', provider: preview.provider };
              this.validateRequiredConsents(consents, active);
            } else if (consents) {
              this.validateRequiredConsents(consents, active);
            }
          }

          const raw = await this.redis.getdel(key);
          if (!raw) throw new UnauthorizedException({ error: 'INVALID_HANDOFF_CODE' });
          const handoff = JSON.parse(raw) as HandoffSession;

          // LOGIN: 활성 문서 read lock을 유지한 채 동의를 append하거나 신규 계정을 만든다.
          if (existing) {
            if (existing.user.status !== UserStatus.ACTIVE) {
              throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
            }
            if (consents) await this.appendConsents(manager, existing.userId, consents);
            return { kind: 'ISSUE_SESSION', userId: existing.userId, legalFingerprint: this.legal.fingerprint(active) };
          }

          const userId = await this.createUser(manager, handoff.provider, handoff.subject, consents!);
          return { kind: 'ISSUE_SESSION', userId, legalFingerprint: this.legal.fingerprint(active) };
        });

      if (decision.kind === 'ISSUE_SESSION') {
        const result: ExchangeResult = {
          kind: 'SESSION',
          tokens: await this.auth.issueSession(decision.userId, decision.legalFingerprint),
        };
        await this.metrics.recordPhase(initial.provider, 'exchange', 'SUCCESS');
        return result;
      }
      await this.metrics.recordPhase(initial.provider, 'exchange', decision.kind);
      return decision;
    } catch (error) {
      await this.metrics.recordPhase(initial.provider, 'exchange', this.operationalError(error));
      throw error;
    }
  }

  private validateRequiredConsents(
    consents: ConsentInput[],
    active: Awaited<ReturnType<LegalDocumentsService['activeDocuments']>>,
  ): void {
    const legalTypes = new Set<ConsentType>(REQUIRED_CONSENTS);
    if (consents.length !== REQUIRED_CONSENTS.length || consents.some((c) => !legalTypes.has(c.type))) {
      throw new BadRequestException({ error: 'REQUIRED_CONSENTS_MISSING' });
    }
    const byType = new Map(consents.map((consent) => [consent.type, consent]));
    if (byType.size !== REQUIRED_CONSENTS.length || REQUIRED_CONSENTS.some((type) => !byType.get(type)?.granted)) {
      throw new BadRequestException({ error: 'REQUIRED_CONSENTS_MISSING' });
    }
    for (const document of active) {
      const consent = byType.get(document.type as unknown as ConsentType);
      if (!consent || consent.documentVersion !== document.version) {
        throw new BadRequestException({ error: 'CONSENT_VERSION_INVALID', type: document.type });
      }
    }
  }

  private async appendConsents(manager: EntityManager, userId: string, consents: ConsentInput[]): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`clawad:consent:${userId}`]);
    const repo = manager.getRepository(Consent);
    const existing = await repo.find({ where: { userId } });
    const additions = consents.filter((consent) => !existing.some((row) =>
      row.type === consent.type && row.documentVersion === consent.documentVersion && row.granted === consent.granted));
    if (additions.length) await repo.save(additions.map((consent) => repo.create({ userId, ...consent })));
  }

  /** 신규 소셜 사용자 생성. email·passwordHash는 NULL. 동시 콜백 경합은 unique 위반으로 멱등 처리. */
  private async createUser(
    manager: EntityManager,
    provider: IdentityProvider,
    subject: string,
    consents: ConsentInput[],
  ): Promise<string> {
    const user = await manager.save(manager.create(User, { email: null, status: UserStatus.ACTIVE }));
    await manager.save(
      manager.create(Identity, { userId: user.id, provider, providerSubject: subject, passwordHash: null }),
    );
    await manager.save(
      consents.map((c) => manager.create(Consent, {
        userId: user.id,
        type: c.type,
        granted: c.granted,
        documentVersion: c.documentVersion,
      })),
    );
    return user.id;
  }

  /** 로그인된 사용자에 provider identity를 연결한다. 자동 계정 병합은 하지 않는다. */
  private async linkIdentity(
    manager: EntityManager,
    userId: string,
    provider: IdentityProvider,
    subject: string,
  ): Promise<void> {
    const user = await manager.getRepository(User).findOneBy({ id: userId });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
    }

    const bySubject = await manager
      .getRepository(Identity)
      .findOne({ where: { provider, providerSubject: subject } });
    if (bySubject) {
      if (bySubject.userId === userId) return; // 같은 사용자·같은 identity 재연결은 멱등.
      // 이 소셜 계정은 다른 사용자에 이미 연결돼 있다. 자동 병합 금지.
      throw new ConflictException({ error: 'IDENTITY_ALREADY_LINKED' });
    }

    const byProvider = await manager.getRepository(Identity).findOne({ where: { userId, provider } });
    if (byProvider) {
      // 이 사용자는 이미 같은 provider의 다른 계정을 연결했다(UNIQUE(userId, provider)).
      throw new ConflictException({ error: 'PROVIDER_ALREADY_LINKED', provider });
    }

    try {
      await manager
        .getRepository(Identity)
        .save(manager.getRepository(Identity).create({ userId, provider, providerSubject: subject, passwordHash: null }));
    } catch (e) {
      // advisory lock 밖의 예기치 않은 경합도 원시 DB 오류 대신 안전한 충돌로 정규화한다.
      if (isUniqueViolation(e)) {
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
