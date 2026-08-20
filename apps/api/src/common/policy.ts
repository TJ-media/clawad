import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * 정책값 단일 원본 (CLAW-12). 기기 상한·토큰 수명 등을 코드에 하드코딩하지 않는다.
 * 루트의 CommonJS 모듈 policy/policy.js를 그대로 재사용한다 — 값 검증(불변식) 로직을 중복하지 않기 위함.
 */
export interface RewardPolicy {
  version: number;
  reward: {
    rewardPerThousandAcceptedImpressions: number;
    dailyAcceptedImpressionLimit: number;
    dailyRewardLimit: number;
    minimumRedemptionPoints: number;
    maxReasonableRedemptionDays: number;
    /** 정책일 경계(분). policyDayKey·nextPolicyDayStart 참고 (CLAW-151). */
    policyDayShiftMinutes: number;
  };
  /** 설문 완료 리워드 (CLAW-97). 노출 기반 일일 상한과 무관한 별개 축이다. */
  survey: { version: string; completionRewardPoints: number };
  device: { maxDevicesPerAccount: number };
  serveToken: {
    ttlMs: number;
    maxUnusedTokensPerMachine: number;
    prefetchRefillThreshold: number;
    refillHorizonMs: number;
  };
  click: { tokenTtlMs: number };
  /** 이용자 제보 (CLAW-234). 포상 금액은 운영자가 정하고 정책은 상한만 강제한다. */
  bugReport: { maxRewardPoints: number; dailySubmitLimit: number; maxBodyLength: number };
  impression: { minViewMs: number; concurrentToleranceMs: number; timeWindowToleranceMs: number; maxUploadDelayMs: number };
  scheduler: { rewardRunIntervalMs: number };
  abuse: { maxContinuousSessionMs: number; continuousSessionMaxGapMs: number };
  frequency: { perCampaignDailyImpressionLimit: number; sameCreativeMinIntervalMs: number };
  /** minDepositKrw·maxDepositKrw는 광고 신청 접수가 받는 입금액 범위다 (CLAW-249). */
  advertiser: {
    defaultCpmKrw: number;
    minDepositKrw: number;
    maxDepositKrw: number;
    clickToImpressionMultiplier: number;
    vatRate: number;
  };
}

/** CPM(1,000회당 원) → 노출 1건당 원. 캠페인 계약 시점에 고정해 저장한다. */
export function pricePerImpressionKrw(cpmKrw: number): number {
  return Math.round(cpmKrw / 1000);
}

/**
 * 인정 노출 누적 count에 대한 총 적립 포인트. policy/policy.js의 pointsForImpressions와 같은 식이지만,
 * 여기서는 rate만 받는 시그니처가 필요해 한 줄(floor)로 둔다 — 계산 규칙 자체는 정책 문서와 동일하다.
 * 노출 단위 적립은 캐리 방식으로 이 함수의 차분을 쓴다: pts_i = total(n+i) − total(n+i−1).
 */
export function pointsForImpressions(rewardPerThousand: number, count: number): number {
  return Math.floor((count * rewardPerThousand) / 1000);
}


const require_ = createRequire(__filename);

// apps/api/src/common → 저장소 루트
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

// require 캐시로 모듈 자체는 어차피 1회만 로드된다. 매 호출 파일을 다시 읽는 것은
// loadPolicy() 안쪽이며(환경변수 오버라이드 즉시 반영, CLAW-102) 그 동작은 그대로다.
const policyModule = require_(join(REPO_ROOT, 'policy', 'policy.js'));

export function loadPolicy(): RewardPolicy {
  return policyModule.loadPolicy() as RewardPolicy;
}

/**
 * 정책일 일자 키 (CLAW-151). 일일 상한(FrequencyService)·상한 초과 판정(EventsService)·
 * 적립 배치(RewardService)·리포트 버킷(AnalyticsService)이 **모두 이 함수 하나**를 쓴다.
 * 구현과 주석은 policy/policy.js에 있다 — 불변식과 마찬가지로 계산식을 중복하지 않는다.
 *
 * SQL 쪽(EventsService의 상한 창, AnalyticsService의 가입자 집계)은 같은 계산을
 * `date_trunc`/`make_interval`로 표현한다. 식이 어긋나면 안 되므로 함께 고친다.
 */
export function policyDayKey(at: Date, shiftMinutes: number): string {
  return policyModule.policyDayKey(at, shiftMinutes) as string;
}

/**
 * 다음 정책일 경계 = 지금 정책일이 끝나고 일일 상한이 초기화되는 시각 (CLAW-151).
 * 클라이언트가 "언제 다시 받을 수 있는지"를 안내하는 데 쓴다 (CLAW-150 `dailyCapResetsAt`).
 */
export function nextPolicyDayStart(at: Date, shiftMinutes: number): Date {
  return policyModule.nextPolicyDayStart(at, shiftMinutes) as Date;
}

/**
 * 기동 시 정책을 1회 로드해 불변식까지 검증한다. 실패하면 예외를 던져 부팅을 막는다.
 *
 * loadPolicy()는 요청 처리 중에 호출되므로(CLAW-102의 환경변수 오버라이드 즉시 반영 요구),
 * 잘못된 정책이 배포되면 기동은 성공하고 광고 결정·노출 업로드·리워드가 전부 500이 된다.
 * 헬스체크는 통과하는데 트래픽만 죽는 실패 양상을 막기 위해, 부팅 시점에 한 번 확인한다.
 * 반환값을 캐시하지 않는 이유도 같다 — 이후 호출은 여전히 그때의 정책 파일을 읽어야 한다.
 */
export function assertPolicyLoadable(): number {
  return loadPolicy().version;
}
