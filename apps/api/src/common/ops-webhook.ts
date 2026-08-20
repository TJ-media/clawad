import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';

/**
 * 운영 알림 웹훅 공통부 (CLAW-251).
 *
 * 제보(CLAW-234)·광고 신청(CLAW-249) 알림이 URL 해석과 전송 코드를 각자 복사해 갖고 있었다.
 * 교환 알림이 세 번째 복사본이 될 자리라 여기로 모은다. 도메인별로 다른 것은 메시지 문안뿐이다.
 *
 * **웹훅은 외부 서비스다.** 개인정보는 싣지 않는다 — 식별자·시각·최소 요약만 보내고
 * 나머지는 운영자 콘솔에서 본다 (privacy-design.md §1.5.3).
 */

/** 웹훅 전송 제한 시간. 알림 때문에 본 요청이 늘어지면 안 된다. */
const TIMEOUT_MS = 5000;

/**
 * 설정 키를 앞에서부터 훑어 처음 값이 있는 것을 쓴다 — 도메인 전용 키를 먼저,
 * 공용 키를 나중에 둔다. URL은 환경변수가 아니라 **파일**에서 읽는다:
 * 환경변수에 직접 넣으면 프로세스 목록·크래시 덤프로 샌다.
 * (`deploy/production/alert-bridge/server.js`가 `ALERT_WEBHOOK_URL_FILE`로 같은 일을 한다.)
 */
export function resolveWebhookUrl(config: ConfigService, ...keys: string[]): string | null {
  const file = keys.map((key) => config.get<string>(key)).find((value) => value);
  if (!file) return null;
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return null;
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * 알림을 보낸다. **실패해도 던지지 않는다** — 알림은 부가 기능이고, 여기서 실패하면
 * 본 작업(제보·신청·교환 저장)까지 되돌아가 사용자가 한 일이 사라진다.
 * 운영자는 콘솔 목록으로도 볼 수 있으므로 실패는 경고 로그로만 남긴다.
 */
export async function postOpsAlert(url: string, text: string, logger: Logger, label: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(`${label} 전송 실패: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.warn(`${label} 전송 실패: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
