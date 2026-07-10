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
}

const require_ = createRequire(__filename);

// apps/api/src/common → 저장소 루트
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

export function loadPolicy(): RewardPolicy {
  const policyModule = require_(join(REPO_ROOT, 'policy', 'policy.js'));
  return policyModule.loadPolicy() as RewardPolicy;
}

export const POLICY_TOKEN = 'CLAWAD_POLICY';
