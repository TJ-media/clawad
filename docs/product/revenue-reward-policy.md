# 수익·정산·리워드 정책 (CLAW-12)

> 상태: 확정 (v2). **모든 단가·상한·간격은 코드에 하드코딩하지 않고 서버 정책 설정으로 관리한다.**
> 정책값 단일 원본: [`policy/reward-policy.default.json`](../../policy/reward-policy.default.json) (운영은 서버 정책 테이블). 검증기: `policy/policy.js`.
> 아래 숫자는 **초기 실험값이며 운영 중 변경 가능한 정책값**이다. 값 변경은 `validateRewardPolicy` 불변식을 통과해야 한다.

## 1. 사업 정의

**클로애드는 광고주가 구매한 개발자 대상 광고 인벤토리를 Claude Code/IDE 사용자에게 제공하고, 검증된 광고 매출의 일부를 비현금성 리워드로 배분하는 광고 매체 플랫폼이다.**

클로애드는 지급수단(포인트) 발행자가 아니다. 리워드는 비구매형·비양도형이며, 지정 상품으로만 교환한다(CLAW-14).

## 2. 돈의 흐름

광고주 공급가액 1,000,000원 집행 예시:

| 단계 | 금액 |
|---|---|
| 광고 공급가액 | 1,000,000원 |
| 부가가치세(10%) | 100,000원 |
| 광고주 결제액 | 1,100,000원 |
| 인정 노출 기준 예산 차감(예약→확정) | — |
| 개발자 리워드 비용 + 쿠폰 원가·지급 수수료 차감 | — |
| **매출총이익** | 나머지 |

차감 비용(배분율 산정 시 고려): VAT, PG 수수료, 쿠폰 구매·발송 수수료, 부정 노출 손실, 환불·미수금, CS, 세무·지급명세, 서버, 영업, 리워드 네트워크 수수료.

## 3. 리워드 정책 (모델 B, 계정 단위)

정책 구조(`RewardPolicy`):

```ts
type RewardPolicy = {
  rewardPerThousandAcceptedImpressions: number; // 인정 노출 1,000회당 P
  dailyAcceptedImpressionLimit: number;         // 일일 유효 노출 상한 (계정 단위)
  dailyRewardLimit: number;                     // 일일 적립 상한 (계정 단위)
  minimumRedemptionPoints: number;              // 최소 교환 포인트
  maxReasonableRedemptionDays: number;          // 최소 교환 도달 허용 기간
};
```

초기 실험값:

| 값 | 초기값 |
|---|---|
| rewardPerThousandAcceptedImpressions | 300 |
| dailyAcceptedImpressionLimit | 500 |
| dailyRewardLimit | 150 |
| minimumRedemptionPoints | 3000 |
| maxReasonableRedemptionDays | 30 |

- 리워드 정책은 광고주 CPM과 **분리 운영**한다.
- 상한·빈도는 **기기별이 아니라 사용자 계정 단위**로 적용한다(여러 기기 동시 사용은 CLAW-18 §동시노출로 한 건만 인정).

### 불변식 (검증기가 강제 — 모순 배포 차단)

1. `dailyRewardLimit ≤ floor(dailyAcceptedImpressionLimit × rewardPerThousand / 1000)`
2. `ceil(minimumRedemptionPoints / min(dailyRewardLimit, 최대적립)) ≤ maxReasonableRedemptionDays`

### 계산 예시 (초기값 기준)

- 최대 적립 가능액/일 = floor(500 × 300 / 1000) = **150P/일**.
- 일일 리워드 상한 150P ≤ 150P → 불변식1 통과(상한이 최대 적립과 일치하는 안전 상한).
- 최소 교환 3,000P ÷ 150P/일 = **20일** ≤ 30일 → 불변식2 통과.

> **이전 초안의 모순 해소**: 구 초안(300/1000 · 500/일 · 일일 1,000P · 최소 5,000P)은 하루 최대 150P만 적립 가능해 상한 1,000P가 도달 불가능하고 5,000P 교환에 과도한 기간이 걸렸다. 일일 리워드 상한을 150P로, 최소 교환을 3,000P로 조정해 불변식을 만족시켰다. 값은 실험값이며 운영 데이터로 재조정한다.

## 4. 광고주 단가 (직판 v1)

- 고정 CPM `advertiser.defaultCpmKrw` 초기값 **2,000원**(공급가, VAT 별도). 클릭 과금(IDE, P2) = 노출 단가 × `clickToImpressionMultiplier`(50).

## 5. 상한 (계정 단위, 정책값)

| 항목 | 정책 키 | 초기값 |
|---|---|---|
| 동일 캠페인 노출/일/계정 | frequency.perCampaignDailyImpressionLimit | 20 |
| 동일 광고 재노출 최소 간격 | frequency.sameCreativeMinIntervalMs | 600000 (10분) |
| 유효 노출/일/계정 | reward.dailyAcceptedImpressionLimit | 500 |
| 적립/일/계정 | reward.dailyRewardLimit | 150 |
| 동시 노출 허용 오차 | impression.concurrentToleranceMs | 2000 |

## 6. 캠페인 유형 (PAID / HOUSE / TEST)

초기엔 유료 캠페인이 적어 하우스·테스트 광고가 필요하다. 캠페인에 `type`을 두고 자격을 강제한다(참조: `server/lib/campaign.js`).

| 유형 | billingEligible | rewardEligible | 비고 |
|---|---|---|---|
| PAID | O | O(정책) | 광고주 과금·리워드, 리포트 포함 |
| HOUSE | X | 기본 X | 명시적 프로모션 정책(opt-in + rewardPolicyId)이 있을 때만 리워드 |
| TEST | X | X | 테스트 포인트·별도 원장만, 실제 매출·리워드와 분리 |

하우스·테스트 광고가 광고주 매출이나 미지급 리워드 부채를 만들지 않도록 한다.

## 7. 리워드 상태 용어

`예상 적립`(클라이언트 미검증) → `검증 중` → `확정 리워드` → `교환 대기` → `지급 완료` / `회수`.

## 8. 예산 차감 시점

서빙 시 예약 → 검증 통과 시 확정 차감 → 거절/만료 시 해제(멱등) → 사후 부정 시 광고주 크레딧 복원 + 리워드 회수. 상세: [ledgers.md](../design/ledgers.md) §예산.

## 9. 미결 (선행 이슈)
- 소득 구분·원천징수 → CLAW-13 / 전자금융거래법 → CLAW-14 / 정책 테이블 구현 → CLAW-23·5.
