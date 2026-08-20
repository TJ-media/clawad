import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { postOpsAlert, resolveWebhookUrl } from '../common/ops-webhook';

/**
 * 교환 신청 접수 알림 (CLAW-251).
 *
 * 알파 지급은 운영자 수동 발송이라, 신청이 들어와도 운영자가 콘솔을 열어보기 전까지 알 수 없었다.
 * 첫 교환이 며칠 방치되는 것을 막는다.
 *
 * **웹훅은 외부 서비스다.** 발송 이메일과 userId를 싣지 않는다 — 교환 ID·상품·차감 포인트·시각만
 * 보내고 발송 주소는 감사 기록되는 reveal 액션으로만 본다 (CLAW-74). 제보·광고 신청 알림이
 * 개인정보를 빼는 것과 같은 기준이다.
 *
 * URL 해석과 전송은 `common/ops-webhook.ts`가 맡는다.
 */
@Injectable()
export class RedemptionNotifierService {
  private readonly logger = new Logger(RedemptionNotifierService.name);

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  /**
   * 접수를 알린다. **실패해도 던지지 않는다** — 알림 실패로 교환 저장이 되돌아가면
   * 사용자 포인트만 차감된 채 주문이 사라진다. 운영자는 대기 큐로도 볼 수 있다.
   */
  async notifyRequested(redemption: {
    id: string;
    productLabel: string;
    pointsDebited: number;
    createdAt: Date;
  }): Promise<boolean> {
    // 제보 알림과 같은 웹훅을 쓰되, 따로 두고 싶으면 REDEMPTION_WEBHOOK_URL_FILE로 분리한다.
    const url = resolveWebhookUrl(this.config, 'REDEMPTION_WEBHOOK_URL_FILE', 'REPORT_WEBHOOK_URL_FILE');
    if (!url) return false;
    const text = [
      '새 교환 신청이 접수되었습니다. 쿠폰을 발송해 주세요.',
      `- 교환 ID: ${redemption.id}`,
      `- 상품: ${redemption.productLabel}`,
      `- 차감 포인트: ${redemption.pointsDebited.toLocaleString('ko-KR')}P`,
      `- 신청 시각: ${redemption.createdAt.toISOString()}`,
      '발송 주소 확인과 처리는 운영자 콘솔의 교환 대기 큐에서 하세요.',
    ].join('\n');
    return postOpsAlert(url, text, this.logger, '교환 신청 알림');
  }
}
