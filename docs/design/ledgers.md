# 4원장 데이터 설계 (CLAW-17)

> 상태: 확정 (v1). 단일 `wallet.balance` 모델을 폐기한다.
> **모든 원장은 append-only. balance 필드 직접 수정 금지. 잔액 = 원장 합산(또는 원장 기반 캐시).**

## 0. 원칙

- 4개 독립 원장: 광고 이벤트 / 광고주 과금 / 사용자 리워드 / 지급.
- 정정은 항목 수정·삭제가 아니라 **반대 분개(reversing entry)** 로만 한다.
- 금액은 서버가 정책(CLAW-12)으로 계산. 클라이언트 전송 금액을 신뢰하지 않는다.
- 정수 최소단위(원/포인트) 저장. 부동소수 금지.

## 1. 광고 이벤트 원장 (`ad_event_ledger`)

노출·클릭·거절의 사실 기록. 과금·리워드의 원천.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigserial PK | |
| impression_id | text UNIQUE | HMAC(serveToken+machineId+sequence), 멱등 |
| campaign_id | bigint FK | |
| creative_id | bigint FK | |
| machine_id_hash | text | 가명 |
| user_id | bigint FK nullable | |
| event_type | enum | request / serve / impression / click / reject |
| reject_reason | enum nullable | bad_token / over_cap / bad_interval / killed / expired ... |
| served_at, reported_start, reported_end | timestamptz | |
| received_at | timestamptz | 서버 수신 |
| sequence | int | 클라이언트 단조 증가 |
| created_at | timestamptz | |

- `impression_id` UNIQUE 제약으로 중복 수집 차단(멱등).

## 2. 광고주 과금 원장 (`billing_ledger`)

캠페인 예산의 예약·확정·환급.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigserial PK | |
| advertiser_id | bigint FK | |
| campaign_id | bigint FK nullable | |
| entry_type | enum | deposit / reserve / capture / release / refund / bonus_credit / ivt_refund |
| amount | bigint | 부호 있는 정수(원). reserve는 hold, capture는 확정 |
| ref_impression_id | text nullable | capture의 근거 노출 |
| memo | text | |
| created_at | timestamptz | |

- 캠페인 가용 예산 = deposit+bonus − (열린 reserve) − capture + release + refund.
- **예산 차감 흐름**: serve 시 `reserve` → 검증 승인 시 같은 금액 `release` 후 `capture`(또는 reserve를 capture로 확정) → 거절/만료 시 `release` → 사후 부정 시 `ivt_refund`(광고주 크레딧 복원).
- 동시성: 캠페인 예산 갱신은 `SELECT ... FOR UPDATE` 또는 조건부 `UPDATE ... WHERE available >= :amt`로 초과 집행 방지.

## 3. 사용자 리워드 원장 (`reward_ledger`)

포인트 적립·회수. 지급수단 아님(CLAW-14).

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigserial PK | |
| user_id | bigint FK | |
| entry_type | enum | accrue_pending / accrue_confirm / claw_back / redeem_debit / admin_adjust |
| points | bigint | 부호 있는 정수(P) |
| ref_impression_id | text nullable | |
| ref_redemption_id | bigint nullable | |
| reason | text | |
| created_at | timestamptz | |

- 상태별 잔액:
  - 확정 잔액 = Σ(accrue_confirm) − Σ(redeem_debit) − Σ(claw_back) + Σ(admin_adjust)
  - 검증중(미확정) = Σ(accrue_pending) 중 아직 confirm/claw_back 안 된 것
- 교환 가능 = 확정 잔액.

## 4. 지급 원장 (`redemption_ledger`)

쿠폰 교환·발송·세무.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigserial PK | |
| redemption_id | bigint | 교환 건 |
| user_id | bigint FK | |
| product_id | bigint FK | 상품 카탈로그 |
| entry_type | enum | request / supplier_order / delivered / delivery_failed / canceled / resent |
| points_debited | bigint | 교환 시 리워드 차감액 |
| tax_status | enum | none / withholding_pending / withholding_done / reported (CLAW-13 결론 반영) |
| supplier_ref | text | 공급사 주문번호 |
| created_at | timestamptz | |

## 5. 리워드 상태 머신

```
예상 적립(클라이언트 표시, 원장 미기록)
  └─ 서버 수신 → accrue_pending  ── "검증 중"
        ├─ 검수 통과 → accrue_confirm ── "확정 리워드"
        │     └─ 교환 신청 → redeem_debit + redemption.request ── "교환 대기"
        │           └─ 공급사 발송 완료 → delivered ── "지급 완료"
        └─ 검수 부정 → claw_back ── "회수" (+ billing.ivt_refund)
```

## 6. 예산·리워드 정합성 규칙

- 노출 1건의 수명: serve(reserve) → impression 보고 → 검증 → accepted면 billing.capture + reward.accrue_pending, rejected면 billing.release.
- 확정 배치(주기적): accrue_pending 중 사후 검수 통과분 → accrue_confirm, 부정분 → claw_back + billing.ivt_refund.
- 잔액 캐시(`*_balance_cache`)를 둘 경우, 원장 합산으로 재계산 가능해야 하며 캐시는 신뢰의 원천이 아니다.

## 7. 구현 연계

- 스키마 구현: CLAW-23(캠페인·예산), CLAW-5(리워드 원장·확정 배치), CLAW-26(지급), CLAW-6(검증→원장 기록).
- 마이그레이션은 P1에서 작성. 이 문서가 ERD·상태전이의 단일 출처.
