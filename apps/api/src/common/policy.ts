import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * 정책값 단일 원본 (CLAW-12). 기기 상한·토큰 수명 등을 코드에 하드코딩하지 않는다.
 * 루트의 CommonJS 모듈 policy/policy.js를 그대로 재사용한다 — 값 검증(불변식) 로직을 중복하지 않기 위함.
 */
export interface RewardPolicy {
  version: number;
  device: { maxDevicesPerAccount: number };
  serveToken: { ttlMs: number; maxUnusedTokensPerMachine: number; prefetchRefillThreshold: number };
  impression: { minViewMs: number; concurrentToleranceMs: number };
  frequency: { perCampaignDailyImpressionLimit: number; sameCreativeMinIntervalMs: number };
  advertiser: { defaultCpmKrw: number; clickToImpressionMultiplier: number; vatRate: number };
}

/** CPM(1,000회당 원) → 노출 1건당 원. 캠페인 계약 시점에 고정해 저장한다. */
export function pricePerImpressionKrw(cpmKrw: number): number {
  return Math.round(cpmKrw / 1000);
}

const require_ = createRequire(__filename);

// apps/api/src/common → 저장소 루트
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

export function loadPolicy(): RewardPolicy {
  const policyModule = require_(join(REPO_ROOT, 'policy', 'policy.js'));
  return policyModule.loadPolicy() as RewardPolicy;
}

export const POLICY_TOKEN = 'CLAWAD_POLICY';
