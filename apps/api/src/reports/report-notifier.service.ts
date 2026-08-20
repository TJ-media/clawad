import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveWebhookUrl, postOpsAlert } from '../common/ops-webhook';

/** 알림에 싣는 본문 요약 길이. 전체 본문은 운영자 콘솔에서만 본다. */
const SUMMARY_LENGTH = 80;

/**
 * 제보 접수 알림 (CLAW-234).
 *
 * **웹훅은 외부 서비스다.** 제보 본문 전체와 답변 이메일을 싣지 않는다 — 제보 ID·제출 시각·본문
 * 앞부분 요약만 보내고 나머지는 운영자 콘솔에서 본다 (privacy-design.md §1.5.3).
 *
 * URL 해석과 전송은 `common/ops-webhook.ts`가 맡는다 (CLAW-251).
 */
@Injectable()
export class ReportNotifierService {
  private readonly logger = new Logger(ReportNotifierService.name);

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  /** 본문 앞부분만. 줄바꿈을 공백으로 눌러 한 줄로 만든다. */
  static summarize(body: string): string {
    const oneLine = body.replace(/\s+/g, ' ').trim();
    return oneLine.length <= SUMMARY_LENGTH ? oneLine : `${oneLine.slice(0, SUMMARY_LENGTH)}…`;
  }

  /**
   * 접수를 알린다. **실패해도 던지지 않는다** — 알림은 부가 기능이고, 여기서 실패하면
   * 제보 저장까지 되돌아가 사용자가 쓴 글이 사라진다. 운영자는 콘솔 목록으로도 볼 수 있다.
   */
  async notifySubmitted(report: { id: string; createdAt: Date; body: string }): Promise<boolean> {
    const url = resolveWebhookUrl(this.config, 'REPORT_WEBHOOK_URL_FILE');
    if (!url) return false;
    const text = [
      '새 제보가 접수되었습니다.',
      `- 제보 ID: ${report.id}`,
      `- 접수 시각: ${report.createdAt.toISOString()}`,
      `- 요약: ${ReportNotifierService.summarize(report.body)}`,
      '전체 내용과 답변은 운영자 콘솔에서 확인하세요.',
    ].join('\n');
    return postOpsAlert(url, text, this.logger, '제보 알림');
  }
}
