import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';

/**
 * 광고 신청 접수 알림 (CLAW-249).
 *
 * **웹훅은 외부 서비스다.** 예금주명·연락처를 싣지 않는다 — 신청 ID·브랜드·금액만 보내고
 * 입금 대사에 필요한 개인정보는 운영자 콘솔에서 본다. `report-notifier.service.ts`가 제보 본문과
 * 회신 이메일을 같은 이유로 빼는 것과 같은 기준이다.
 *
 * URL은 환경변수가 아니라 파일에서 읽는다 — 프로세스 목록·크래시 덤프로 새지 않게 한다.
 */
@Injectable()
export class InquiryNotifierService {
  private readonly logger = new Logger(InquiryNotifierService.name);

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private webhookUrl(): string | null {
    // 제보 알림과 같은 웹훅을 쓰되, 따로 두고 싶으면 INQUIRY_WEBHOOK_URL_FILE로 분리한다.
    const file =
      this.config.get<string>('INQUIRY_WEBHOOK_URL_FILE') ?? this.config.get<string>('REPORT_WEBHOOK_URL_FILE');
    if (!file) return null;
    try {
      const raw = readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
      if (!raw) return null;
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  /**
   * 접수를 알린다. **실패해도 던지지 않는다** — 알림은 부가 기능이고, 여기서 실패하면 접수 저장까지
   * 되돌아가 광고주가 넣은 신청이 사라진다. 운영자는 콘솔 목록으로도 볼 수 있다.
   */
  async notifySubmitted(inquiry: {
    id: string;
    brandName: string;
    depositAmountKrw: number;
    createdAt: Date;
  }): Promise<boolean> {
    const url = this.webhookUrl();
    if (!url) return false;
    const text = [
      '새 광고 신청이 접수되었습니다.',
      `- 신청 ID: ${inquiry.id}`,
      `- 광고주명: ${inquiry.brandName}`,
      `- 입금 예정 금액: ${inquiry.depositAmountKrw.toLocaleString('ko-KR')}원`,
      `- 접수 시각: ${inquiry.createdAt.toISOString()}`,
      '예금주·연락처와 소재 전문은 운영자 콘솔에서 확인하세요.',
    ].join('\n');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        this.logger.warn(`광고 신청 알림 전송 실패: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(`광고 신청 알림 전송 실패: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
