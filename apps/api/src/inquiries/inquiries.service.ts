import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { loadPolicy, pricePerImpressionKrw } from '../common/policy';
import { maskEmail } from '../redemption/redemption.service';
import { Inquiry, InquiryContactType, InquiryStatus } from './inquiry.entity';
import { InquiryNotifierService } from './inquiry-notifier.service';

/** 미리보기 화면(preview-model.js)과 같은 상한. 화면이 자른 값을 서버가 다시 자른다. */
export const CREATIVE_TEXT_MAX_LENGTH = 48;
export const BRAND_NAME_MAX_LENGTH = 23;
export const DEPOSITOR_NAME_MAX_LENGTH = 40;

export interface SubmitInquiryInput {
  creativeText: string;
  brandName: string;
  linkUrl?: string;
  depositAmountKrw: number;
  depositorName: string;
  contact: string;
}

export interface InquirySubmitResult {
  inquiryId: string;
  status: InquiryStatus;
  pricePerImpressionKrw: number;
  estimatedImpressions: number;
  receivedAt: string;
}

export interface AdminInquiryView {
  id: string;
  creativeText: string;
  brandName: string;
  linkUrl: string | null;
  depositAmountKrw: number;
  /** 은행 입금 내역과 대조하는 키라 마스킹하지 않는다. */
  depositorName: string;
  /** 원문은 감사에 남는 revealContact()로만 본다. */
  contactMasked: string;
  contactType: InquiryContactType;
  status: InquiryStatus;
  pricePerImpressionKrwAtReceipt: number;
  estimatedImpressions: number;
  campaignId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 제어문자를 공백으로 바꾸고 연속 공백을 눌러 상한까지 자른다. 미리보기 화면의 `sanitizeField`와
 * 같은 규칙이지만 **화면 결과를 믿지 않고 서버가 다시 수행한다** (rules §2).
 */
export function sanitizeField(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : '';
  const normalized = text
    // \p{Cc} = 유니코드 제어문자(U+0000-001F, U+007F-009F). 소스에 제어문자를 직접 넣지 않는다.
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...normalized].slice(0, maxLength).join('');
}

/** https만 통과시킨다. 미리보기의 `normalizePreviewLink`와 같은 규칙을 서버에서 다시 본다. */
export function normalizeLinkUrl(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (/\s/.test(raw)) throw new BadRequestException({ error: 'INVALID_INPUT', field: 'linkUrl' });

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https:\/\//i.test(raw)) {
    throw new BadRequestException({ error: 'INVALID_INPUT', field: 'linkUrl' });
  }
  try {
    const parsed = new URL(hasScheme ? raw : `https://${raw}`);
    const labels = parsed.hostname.split('.');
    const validHostname =
      labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !validHostname) {
      throw new BadRequestException({ error: 'INVALID_INPUT', field: 'linkUrl' });
    }
    return parsed.href.slice(0, 2048);
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException({ error: 'INVALID_INPUT', field: 'linkUrl' });
  }
}

/**
 * 연락처가 이메일인지 국내 휴대전화인지 서버가 판정한다. 클라이언트가 보낸 종류를 쓰지 않는다.
 * 전화번호는 하이픈·공백을 떼고 저장해 운영자가 그대로 걸 수 있게 한다.
 */
export function classifyContact(value: unknown): { contact: string; contactType: InquiryContactType } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw) && raw.length <= 254) {
    return { contact: raw.toLowerCase(), contactType: InquiryContactType.EMAIL };
  }
  const digits = raw.replace(/[\s-]/g, '');
  if (/^01[016789]\d{7,8}$/.test(digits)) {
    return { contact: digits, contactType: InquiryContactType.PHONE };
  }
  throw new BadRequestException({ error: 'INVALID_INPUT', field: 'contact' });
}

@Injectable()
export class InquiriesService {
  constructor(
    @InjectRepository(Inquiry) private readonly inquiries: Repository<Inquiry>,
    private readonly notifier: InquiryNotifierService,
  ) {}

  /** 화면이 표시할 금액 정보. 숫자를 화면에 하드코딩하지 않기 위해 서버가 내려준다 (rules §5). */
  limits(): { pricePerImpressionKrw: number; minDepositKrw: number; maxDepositKrw: number } {
    const { advertiser } = loadPolicy();
    return {
      pricePerImpressionKrw: pricePerImpressionKrw(advertiser.defaultCpmKrw),
      minDepositKrw: advertiser.minDepositKrw,
      maxDepositKrw: advertiser.maxDepositKrw,
    };
  }

  async submit(input: SubmitInquiryInput): Promise<InquirySubmitResult> {
    const { pricePerImpressionKrw: price, minDepositKrw, maxDepositKrw } = this.limits();

    const creativeText = sanitizeField(input.creativeText, CREATIVE_TEXT_MAX_LENGTH);
    if (!creativeText) throw new BadRequestException({ error: 'INVALID_INPUT', field: 'creativeText' });

    const brandName = sanitizeField(input.brandName, BRAND_NAME_MAX_LENGTH);
    if (!brandName) throw new BadRequestException({ error: 'INVALID_INPUT', field: 'brandName' });

    const depositorName = sanitizeField(input.depositorName, DEPOSITOR_NAME_MAX_LENGTH);
    if (!depositorName) throw new BadRequestException({ error: 'INVALID_INPUT', field: 'depositorName' });

    const amount = input.depositAmountKrw;
    if (!Number.isInteger(amount) || amount < minDepositKrw || amount > maxDepositKrw) {
      throw new BadRequestException({ error: 'INVALID_INPUT', field: 'depositAmountKrw', minDepositKrw, maxDepositKrw });
    }

    const linkUrl = normalizeLinkUrl(input.linkUrl);
    const { contact, contactType } = classifyContact(input.contact);

    const saved = await this.inquiries.save(
      this.inquiries.create({
        creativeText,
        brandName,
        linkUrl,
        depositAmountKrw: amount,
        depositorName,
        contact,
        contactType,
        status: InquiryStatus.RECEIVED,
        pricePerImpressionKrwAtReceipt: price,
      }),
    );

    await this.notifier.notifySubmitted(saved);

    return {
      inquiryId: saved.id,
      status: saved.status,
      pricePerImpressionKrw: price,
      estimatedImpressions: Math.floor(amount / price),
      receivedAt: saved.createdAt.toISOString(),
    };
  }

  async listForAdmin(): Promise<AdminInquiryView[]> {
    const rows = await this.inquiries.find({ order: { createdAt: 'DESC' }, take: 200 });
    return rows.map((row) => this.toAdminView(row));
  }

  /** 연락처 원문. 알림을 보낼 때만 쓰며 감사 로그에 남는 경로로만 노출한다. */
  async revealContact(id: string): Promise<{ inquiryId: string; contact: string }> {
    const row = await this.inquiries.findOne({ where: { id } });
    if (!row) throw new NotFoundException({ error: 'INQUIRY_NOT_FOUND' });
    return { inquiryId: row.id, contact: row.contact };
  }

  async updateStatus(id: string, status: InquiryStatus, note?: string): Promise<AdminInquiryView> {
    const row = await this.inquiries.findOne({ where: { id } });
    if (!row) throw new NotFoundException({ error: 'INQUIRY_NOT_FOUND' });
    row.status = status;
    if (note !== undefined) row.note = sanitizeField(note, 2000) || null;
    return this.toAdminView(await this.inquiries.save(row));
  }

  /** 전화번호는 가운데를 가린다. 이메일은 기존 maskEmail을 그대로 쓴다. */
  static maskContact(contact: string, type: InquiryContactType): string {
    if (type === InquiryContactType.EMAIL) return maskEmail(contact) ?? '***';
    return contact.length <= 5 ? '***' : `${contact.slice(0, 3)}****${contact.slice(-4)}`;
  }

  private toAdminView(row: Inquiry): AdminInquiryView {
    return {
      id: row.id,
      creativeText: row.creativeText,
      brandName: row.brandName,
      linkUrl: row.linkUrl,
      depositAmountKrw: row.depositAmountKrw,
      depositorName: row.depositorName,
      contactMasked: InquiriesService.maskContact(row.contact, row.contactType),
      contactType: row.contactType,
      status: row.status,
      pricePerImpressionKrwAtReceipt: row.pricePerImpressionKrwAtReceipt,
      // 접수 시점 단가로 계산한다 — 정책이 바뀌어도 광고주가 신청한 조건이 기준이다.
      estimatedImpressions: Math.floor(row.depositAmountKrw / row.pricePerImpressionKrwAtReceipt),
      campaignId: row.campaignId,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
