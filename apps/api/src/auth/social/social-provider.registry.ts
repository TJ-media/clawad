import { IdentityProvider } from '../../entities/identity.entity';
import { SocialProvider } from './provider.interface';

/**
 * 활성화된 소셜 공급자 어댑터를 provider별로 조회한다.
 * 미설정 공급자는 목록에 없고 get()이 null을 반환한다 — 상위에서 400으로 거절한다.
 * e2e에서는 이 레지스트리를 mock 어댑터로 override해 실제 공급자에 접속하지 않는다.
 */
export class SocialProviderRegistry {
  private readonly providers: Map<IdentityProvider, SocialProvider>;

  constructor(providers: SocialProvider[]) {
    this.providers = new Map(providers.map((p) => [p.provider, p]));
  }

  get(provider: IdentityProvider): SocialProvider | null {
    return this.providers.get(provider) ?? null;
  }

  enabledProviders(): IdentityProvider[] {
    return [...this.providers.keys()];
  }
}
