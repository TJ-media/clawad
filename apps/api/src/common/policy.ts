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
  impression: { minViewMs: number; concurrentToleranceMs: number; timeWindowToleranceMs: number; maxUploadDelayMs: number };
  scheduler: { rewardRunIntervalMs: number };
  abuse: { maxContinuousSessionMs: number; continuousSessionMaxGapMs: number };
  frequency: { perCampaignDailyImpressionLimit: number; sameCreativeMinIntervalMs: number };
  advertiser: { defaultCpmKrw: number; clickToImpressionMultiplier: number; vatRate: number };
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

export function loadPolicy(): RewardPolicy {
  const policyModule = require_(join(REPO_ROOT, 'policy', 'policy.js'));
  return policyModule.loadPolicy() as RewardPolicy;
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
