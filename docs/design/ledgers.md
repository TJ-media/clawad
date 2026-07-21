# 4원장 데이터 설계 (CLAW-17)

> 상태: 확정 (v2). 단일 `wallet.balance` 모델을 폐기한다.
> **모든 원장은 append-only. balance 필드 직접 수정 금지. 잔액 = 원장 합산(또는 원장 기반 캐시).**
> 참조 구현(PoC): `server/index.js`, `server/lib/*`. 운영은 PostgreSQL로 옮긴다.

## 0. 원칙

- 4개 독립 원장: 광고 이벤트 / 광고주 과금 / 사용자 리워드 / 지급.
- 정정은 항목 수정·삭제가 아니라 **반대 분개(reversing entry)** 또는 상태 전이 기록으로만.
- 금액은 서버가 정책(CLAW-12)으로 계산. 클라이언트 전송 금액을 신뢰하지 않는다.
- 정수 최소단위(원/포인트) 저장. 부동소수 금지.

## 1. 사용자·기기 모델 (계정 단위 정책의 기반)

- `users` 1 : N `machines`, 단 **활성 기기 최대 N대**(정책값 `device.maxDevicesPerAccount`, 기본 3).
- 네 번째 기기 등록은 `409 MACHINE_LIMIT_EXCEEDED`. 새 기기를 등록하려면 기존 기기를 먼저 해제한다.
- 기기 등록 검사는 **DB 트랜잭션 안에서** 수행해 동시 요청으로 상한을 초과하지 못하게 한다(행 잠금 또는 조건부 COUNT/INSERT).
- 여러 로그인 수단(이메일·Google·GitHub 등)은 하나의 `users` 레코드에 연결한다. 로그인 수단이 여러 개인 것을 여러 계정으로 보지 않는다.
- 머신 ID는 로컬 생성 랜덤 가명값이다. 하드웨어 식별자(MAC·디스크 시리얼·HW UUID)를 저장하지 않는다(CLAW-15).
- 일일 노출 상한·캠페인 빈도·리워드 상한은 **기기별이 아니라 사용자 계정 단위**로 적용한다.

## 2. 광고 이벤트 원장 (`ad_event_ledger`)

노출·클릭·거절의 사실 기록. 과금·리워드의 원천.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigserial PK | |
| idempotency_key | text UNIQUE | 서버 생성 SHA-256(token_jti:machine_id:sequence) |
| token_jti | text | serveToken의 jti |
| machine_id | text | 가명 |
| user_id | bigint FK | |
| campaign_id | bigint FK | |
| campaign_type | enum | PAID / HOUSE / TEST |
| decision | enum | ACCEPTED / REJECTED |
| reject_reason | enum nullable | BAD_TOKEN / EXPIRED / BAD_INTERVAL / CONCURRENT_USER_IMPRESSION / OVER_CAP / KILLED ... |
| started_at, ended_at | timestamptz | 클라이언트 보고 |
| sequence | int | 클라이언트 단조 증가 |
| received_at | timestamptz | 서버 수신 |

- 멱등: `UNIQUE(token_jti, machine_id, sequence)` 및 `UNIQUE(idempotency_key)`.
- **동시 노출로 제외된 이벤트도 원장에 남긴다**: `decision=REJECTED, reject_reason=CONCURRENT_USER_IMPRESSION`. 단 과금·리워드·유효 노출·리포트 유효 노출을 만들지 않는다. 수신 수·무효 사유 통계에는 포함한다(CLAW-18 §6).
- 지연 업로드로 동시 노출 승자가 바뀌어도 기존 행을 수정하지 않는다. `impression_decision_transitions`에 이전/이후 판정과 유효 과금·리워드 플래그를 append하며, 조회와 배치는 가장 최신 전이를 유효 상태로 사용한다(CLAW-42).

## 3. 광고주 과금 원장 (`billing_ledger`)

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigserial PK | |
| advertiser_id, campaign_id | bigint FK | |
| entry_type | enum | deposit / reserve / capture / release / refund / bonus_credit / ivt_refund |
| amount | bigint | 부호 있는 정수(원) |
| ref_idempotency_key | text nullable | capture의 근거 노출 |
| created_at | timestamptz | |

- 가용 예산 = `SUM(amount)`. deposit·bonus_credit·refund·ivt_refund는 (+), capture는 (−).
- **HOUSE·TEST 캠페인은 과금 원장을 만들지 않는다**(billingEligible=false). 광고주 매출·부채를 발생시키지 않는다(CLAW-6 §캠페인).

### 예산 처리 방식 (채택안 명시)

**알파는 예약 원장을 사용하지 않는다.** CLAW-12·CLAW-16·CLAW-17이 확정한 방식과 일치시킨다.

```
광고 결정(토큰 발급) → 예산 가용성만 확인. 원장 행을 만들지 않는다.
노출 검증 승인       → capture (확정 차감, 멱등)
노출 거절·토큰 만료  → 아무 것도 하지 않는다 (해제할 예약이 없음)
사후 부정 판정       → ivt_refund (광고주 크레딧 복원) + reward.claw_back
동시 노출 재투영     → refund (이전 승자) + capture (새 승자), 모두 별도 멱등 키로 append
```

- **프리페치·미사용 serveToken·토큰 만료·캐시 폐기는 예산 reserve/release를 만들지 않는다** (CLAW-17). 만료 토큰 스윕 배치가 필요 없다.
- `entry_type`에 `reserve`/`release`를 정의만 해두고 알파에서는 **쓰지 않는다.** PAID 트래픽이 실제로 초과 집행을 일으키면 마이그레이션 없이 켤 수 있다.
- 동시성: 캠페인 행을 `SELECT ... FOR UPDATE`로 잠근 뒤 원장을 합산해 `capture`를 append한다. 초과 집행을 막는다.
- 멱등: `UNIQUE(idempotency_key)`. 같은 노출로 두 번 capture하지 않는다.

> 이전 판(커밋 `50ecf40`)은 "예약 원장 유지"를 채택하며 *"예약 원장이 이미 안정적이면 폐기하지 않는다"* 를 근거로 들었으나, 예약 원장은 구현된 적이 없어 전제가 성립하지 않았다. CLAW-12·16·17의 확정 문구와도 모순이었다.

#### 예산 소진 시 부담 주체 (확정)

예약이 없으므로, 사용자가 광고를 유효하게 표시한 뒤 승인 시점에 예산이 소진돼 있을 수 있다.

- **이 손실은 사용자에게 전가하지 않는다. 클로애드가 부담한다.**
- 광고주 과금은 발생하지 않는다(`BUDGET_EXHAUSTED`, capture 없음).
- 사용자 리워드는 **회사 재원**으로 적립한다(HOUSE 프로모션 재원 + 명시적 `rewardPolicyId` — CLAW-20 §유형별 정책의 예외 경로).
- `BUDGET_EXHAUSTED`는 부정행위 신호가 아니다. 제재 이력·위험 점수에 넣지 않는다 (CLAW-19).
- 완화: 광고 결정 단계에서 가용 예산이 `미사용 토큰 추정치 × 단가`보다 적으면 해당 PAID 캠페인을 후보에서 제외하고 HOUSE로 폴백한다. 이 검사는 조언적이며 원장 행을 만들지 않는다.

## 4. 사용자 리워드 원장 (`reward_ledger`)

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigserial PK | |
| user_id | bigint FK | |
| entry_type | enum | accrue_pending / accrue_confirm / claw_back / redeem_debit / admin_adjust |
| points | bigint | 부호 있는 정수(P) |
| ref_idempotency_key | text nullable | |
| reason | text | |
| created_at | timestamptz | |

- 확정 잔액 = Σ accrue_confirm − Σ redeem_debit − Σ claw_back + Σ admin_adjust.
- 적립 포인트는 서버가 정책(`pointsForImpressions`)으로 계산. 일일 상한은 계정 단위.
- **HOUSE 기본·TEST는 리워드 원장을 만들지 않는다**. HOUSE는 명시적 프로모션 정책(opt-in + rewardPolicyId)이 있을 때만. TEST는 별도 테스트 원장으로만 분리해 실제 리워드·매출과 섞지 않는다.
- 동시 노출 재투영 전에 이미 리워드가 생겼다면 `REPROJECTION_ADJUST`를 append해 상쇄하거나 복원한다. 검증 중/확정 잔액을 구분하며, IVT `CLAW_BACK`을 재투영이 되돌리지 않는다.

## 5. 지급 원장 (`redemption_ledger`)

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigserial PK | |
| redemption_id, user_id | bigint | |
| product_id | bigint FK | 상품 카탈로그 화이트리스트 |
| entry_type | enum | request / supplier_order / delivered / delivery_failed / canceled / resent |
| points_debited | bigint | |
| tax_status | enum | none / withholding_pending / withholding_done / reported (CLAW-13 결론 반영) |
| supplier_ref | text | |
| created_at | timestamptz | |

## 6. 리워드 상태 머신

```
예상 적립(클라이언트 표시, 원장 미기록)
  └─ 서버 수신·검증 → accrue_pending ── "검증 중"
        ├─ 사후 검수 통과 → accrue_confirm ── "확정 리워드"
        │     └─ 교환 신청 → redeem_debit + redemption.request ── "교환 대기"
        │           └─ 발송 완료 → delivered ── "지급 완료"
        └─ 검수 부정 → claw_back ── "회수" (+ billing.ivt_refund)
```

## 7. 구현 연계
- 스키마: CLAW-23(캠페인·예산), CLAW-5(리워드 원장·확정 배치), CLAW-26(지급), CLAW-6(검증→원장). 마이그레이션은 P1.
- 참조 판정 모듈: `server/lib/idempotency.js`, `concurrentDedup.js`, `deviceLimit.js`, `campaign.js`.
