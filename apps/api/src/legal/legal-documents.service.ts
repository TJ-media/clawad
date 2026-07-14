import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Consent, ConsentType, REQUIRED_CONSENTS } from '../entities/consent.entity';
import { LegalDocument, LegalDocumentType } from './legal-document.entity';
import { isStrictIsoDate } from './legal-validation';

export interface PublicLegalDocument {
  type: LegalDocumentType;
  version: string;
  url: string;
  effectiveAt: string;
}

@Injectable()
export class LegalDocumentsService implements OnModuleInit {
  constructor(
    @InjectRepository(LegalDocument) private readonly documents: Repository<LegalDocument>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const configured = [
      this.configuredDocument(LegalDocumentType.TERMS_OF_SERVICE, 'LEGAL_TERMS'),
      this.configuredDocument(LegalDocumentType.PRIVACY_POLICY, 'LEGAL_PRIVACY'),
    ];
    await this.dataSource.transaction(async (manager) => {
      await this.lockPolicy(manager, false);
      for (const document of configured) await this.activateMonotonically(manager, document);
    });
  }

  private required(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value) throw new Error(`${key} 환경변수가 필요합니다.`);
    return value;
  }

  private validateUrl(value: string, key: string): string {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${key}는 유효한 공개 URL이어야 합니다.`); }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new Error(`${key}는 운영에서 HTTPS URL이어야 합니다.`);
    }
    if (url.username || url.password) throw new Error(`${key}에 자격증명을 포함할 수 없습니다.`);
    return url.toString();
  }

  private configuredDocument(type: LegalDocumentType, prefix: string): Omit<LegalDocument, 'id' | 'createdAt'> {
    const versionKey = `${prefix}_VERSION`;
    const urlKey = `${prefix}_URL`;
    const effectiveKey = `${prefix}_EFFECTIVE_AT`;
    const version = this.required(versionKey);
    if (version.length > 32) throw new Error(`${versionKey}는 32자 이하여야 합니다.`);
    const publicUrl = this.validateUrl(this.required(urlKey), urlKey);
    const effectiveAt = this.required(effectiveKey);
    if (!isStrictIsoDate(effectiveAt)) {
      throw new Error(`${effectiveKey}는 YYYY-MM-DD 형식이어야 합니다.`);
    }
    return { type, version, publicUrl, effectiveAt, active: true };
  }

  private async activateMonotonically(
    manager: EntityManager,
    configured: Omit<LegalDocument, 'id' | 'createdAt'>,
  ): Promise<void> {
    const repo = manager.getRepository(LegalDocument);
    const [active, existing] = await Promise.all([
      repo.findOne({ where: { type: configured.type, active: true } }),
      repo.findOne({ where: { type: configured.type, version: configured.version } }),
    ]);
    if (existing && (existing.publicUrl !== configured.publicUrl || existing.effectiveAt !== configured.effectiveAt)) {
      throw new Error(`${configured.type} ${configured.version} 문서 메타데이터는 변경할 수 없습니다. 새 버전을 등록하세요.`);
    }
    if (active?.version === configured.version) return;
    if (active && active.effectiveAt >= configured.effectiveAt) {
      if (active.effectiveAt === configured.effectiveAt) {
        throw new Error(`${configured.type}의 같은 시행일에 서로 다른 버전을 활성화할 수 없습니다.`);
      }
      return; // 구버전 인스턴스 재시작이 더 최신 문서를 되돌리지 못하게 한다.
    }
    await repo.update({ type: configured.type, active: true }, { active: false });
    if (existing) {
      existing.active = true;
      await repo.save(existing);
    } else {
      await repo.save(repo.create(configured));
    }
  }

  private lockPolicy(manager: EntityManager, shared: boolean): Promise<unknown> {
    const fn = shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    return manager.query(`SELECT ${fn}(hashtext('clawad:legal-policy'))`);
  }

  async withPolicyReadLock<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockPolicy(manager, true);
      return work(manager);
    });
  }

  async activeDocuments(manager?: EntityManager): Promise<PublicLegalDocument[]> {
    const repo = manager ? manager.getRepository(LegalDocument) : this.documents;
    const rows = await repo.find({ where: { active: true }, order: { type: 'ASC' } });
    if (rows.length !== 2 || new Set(rows.map((row) => row.type)).size !== 2) {
      throw new Error('활성 필수 법률 문서 구성이 올바르지 않습니다.');
    }
    return rows.map((row) => ({ type: row.type, version: row.version, url: row.publicUrl, effectiveAt: row.effectiveAt }));
  }

  fingerprint(documents: PublicLegalDocument[]): string {
    const canonical = JSON.stringify([...documents]
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((document) => [document.type, document.version]));
    return createHash('sha256').update(canonical).digest('base64url');
  }

  async activeFingerprint(): Promise<string> {
    return this.fingerprint(await this.activeDocuments());
  }

  async currentFingerprintForUser(userId: string): Promise<string | null> {
    return this.withPolicyReadLock(async (manager) => {
      const active = await this.activeDocuments(manager);
      const granted = await manager.getRepository(Consent).find({ where: { userId, granted: true } });
      const current = active.every((document) => granted.some((consent) =>
        consent.type === (document.type as unknown as ConsentType) && consent.documentVersion === document.version));
      return current ? this.fingerprint(active) : null;
    });
  }

  async userNeedsCurrentConsents(userId: string, manager: EntityManager): Promise<boolean> {
    const [active, granted] = await Promise.all([
      this.activeDocuments(manager),
      manager.getRepository(Consent).find({ where: { userId, granted: true } }),
    ]);
    return REQUIRED_CONSENTS.some((type) => {
      const document = active.find((item) => item.type === (type as unknown as LegalDocumentType));
      return !document || !granted.some((consent) => consent.type === type && consent.documentVersion === document.version);
    });
  }

  async publicBundle(): Promise<Record<string, unknown>> {
    return {
      documents: await this.activeDocuments(),
      disclosures: [
        '개발 도구 상태줄에 [광고]로 표시된 광고를 제공합니다.',
        '리워드는 구매 없이 적립되며 비현금성·비양도형이고 지정 상품으로만 교환됩니다.',
        '프롬프트·터미널 입력·파일명·프로젝트 경로·소스 내용은 수집하지 않습니다.',
      ],
      privacyContactUrl: this.validateUrl(this.required('LEGAL_PRIVACY_CONTACT_URL'), 'LEGAL_PRIVACY_CONTACT_URL'),
      removalGuideUrl: this.validateUrl(this.required('LEGAL_REMOVAL_GUIDE_URL'), 'LEGAL_REMOVAL_GUIDE_URL'),
    };
  }
}
