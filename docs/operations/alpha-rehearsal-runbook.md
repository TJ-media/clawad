# HOUSE·TEST 캠페인·리워드 지급 리허설 런북 (CLAW-66)

실제 알파 테스터를 투입하기 전에, **과금·현금성 지급 없이** 전체 운영 흐름(노출→검증 중→확정→교환 대기→수동 쿠폰 지급→지급 완료)과 예외 시나리오를 리허설한다. 이 문서는 운영자가 따라 하는 절차와, 각 단계에서 확인할 **불변식**을 정의한다.

- 대상 환경: 운영 스택. 단 **전용 리허설 캠페인·QA 계정·전용 데이터**만 사용한다.
- 결과 기록: [`scripts/alpha-rehearsal-report.js`](../../scripts/alpha-rehearsal-report.js)에 결과 JSON을 채워 Markdown 리포트를 생성한다. 이 스크립트가 HOUSE·TEST 매출·부채 0 게이트와 PII 미기록을 강제한다.
- 관련 이슈: CLAW-10, CLAW-5, CLAW-23, CLAW-25, CLAW-26, CLAW-44, CLAW-55, CLAW-74.

> 모든 API는 관리자 인증(RBAC)·감사 대상이다. 역할: 상품·캠페인 생성=SUPERADMIN, 심사·전이=REVIEWER, 예산·지급=SETTLER. 쿠폰 코드·발송 이메일 원문·토큰을 로그·리포트에 남기지 않는다.

---

## 0. 원칙 (리허설이 지켜야 하는 불변식)

- **HOUSE·TEST는 광고주 매출과 미지급 리워드 부채를 만들지 않는다.** PAID만 과금·매출 자격을 가진다.
- HOUSE는 캠페인에 `rewardPolicyId`(회사 재원 정책)가 설정된 경우에만 리워드를 적립한다(원장에는 `companyFunded`로 표기). 값이 없으면 HOUSE는 리워드를 만들지 않는다. TEST는 `rewardPolicyId` 자체가 금지다.
- 포인트 차감·원복·회수는 append-only 원장(reward_ledger / redemption_ledger)으로만 이뤄진다. balance 직접 수정 없음.
- 리워드 단가·상한·간격은 정책 설정에서만 온다(코드 하드코딩 금지). 세율·과세 기준은 확정 사실로 쓰지 않는다(CLAW-13 미확정).

---

## 1. 리허설 캠페인·소재 준비

1. 광고주(리허설용): `POST /internal/v1/advertisers` (SUPERADMIN).
2. HOUSE 캠페인: `POST /internal/v1/campaigns` — `type: "HOUSE"`, `pricePerImpressionKrw: 0`. 회사 재원 리워드를 검증하려면 `rewardPolicyId`를 설정한 변형도 하나 만든다.
3. TEST 캠페인: `POST /internal/v1/campaigns` — `type: "TEST"`, `pricePerImpressionKrw: 0`. `rewardPolicyId`를 넣으면 400으로 거부된다.
4. 소재 등록·심사: `POST /internal/v1/campaigns/:id/creatives` (SUPERADMIN) → `POST /internal/v1/creatives/:id/review` (REVIEWER). **안전한 클릭 목적지**(내부/신뢰 URL)만 사용한다.
5. 캠페인 활성 전이: `POST /internal/v1/campaigns/:id/transition` (REVIEWER).
6. (참고) PAID 분리 확인용으로 PAID 캠페인 1건에 예산을 `POST /internal/v1/campaigns/:id/budget/credit` (SETTLER)로 적립해 둔다. 리허설에서 실제 과금은 발생시키지 않는다.

**확인(불변식)**: 캠페인 유형이 PAID/HOUSE/TEST로 정확히 저장되고, HOUSE·TEST 캠페인에는 예산·매출 개념이 붙지 않는다.

## 2. 노출→검증 중→확정

1. 리허설 QA 계정으로 클라이언트를 설치·로그인하고, 활성 작업 상태에서 광고를 5초 이상 노출→sync 업로드한다(실 클라이언트 또는 QA 하니스).
2. 사후 검수·적립: `POST /internal/v1/rewards/run-accrual` (검증 중=예상 적립), 검수 통과분 확정: `POST /internal/v1/rewards/run-confirmation` (확정 리워드).
3. 대시보드에서 노출·유효 노출·클릭·CTR·거절 사유를 확인: `GET /internal/v1/analytics/*` (CLAW-25).

**확인(불변식)**:
- HOUSE(비-funded)·TEST 노출은 `reward_ledger`에 적립을 만들지 않는다. HOUSE(funded)만 회사 재원으로 적립한다.
- HOUSE·TEST 노출은 `billing_ledger`에 광고주 과금(CAPTURE)을 만들지 않는다 → **광고주 매출 0**.
- 사용자 화면의 예상/검증 중/확정 값이 서버 원장 합산과 일치한다.

## 3. 교환 대기→수동 쿠폰 지급→지급 완료 (CLAW-26·74)

1. QA 사용자가 user-web에서 상품을 교환한다. 이때 **발송 이메일 입력·동의**가 필수다(CLAW-74). 교환 시 확정 포인트가 차감되고 상태가 `교환 대기(REQUESTED)`가 된다.
2. 운영자 대기 큐 확인: `GET /internal/v1/redemptions/pending` (SETTLER) — 발송 이메일은 **마스킹**으로만 보인다.
3. 실제 발송 직전에만 정확한 주소 확인: `POST /internal/v1/redemptions/:id/reveal-email` (SETTLER, 감사 기록됨).
4. 쿠폰을 수동 발송한 뒤 지급 완료 전이: `POST /internal/v1/redemptions/:id/deliver` (SETTLER).

**확인(불변식)**:
- `deliver` 후 해당 교환의 `deliveryEmail`이 **NULL로 파기**되고, 동의 시각(`deliveryEmailConsentAt`)은 증적으로 유지된다.
- 지급 완료된 교환은 재전이 불가(이중 처리 방지).
- 쿠폰 코드·발송 주소 원문이 애플리케이션 로그에 남지 않는다.

## 4. 예외 시나리오 — 환불·claw_back·실패·재시도·조정

- **발송 실패**: `POST /internal/v1/redemptions/:id/fail` → 차감 포인트 원복, 상태 `발송 실패`. 재시도는 사용자가 재교환한다.
- **취소**: `POST /internal/v1/redemptions/:id/cancel` → 차감 포인트 원복.
- **claw_back / 관리자 조정**: 리워드 원장에 반대 분개(ADMIN_ADJUST 등)로만 정정한다(원장 수정·삭제 금지).

**확인(불변식)**: 실패·취소·회수 후 확정 잔액이 원장 합산과 정확히 일치하고, 이중 원복이 없다. 종결(취소·실패) 시 발송 이메일이 파기된다.

## 5. 운영 통제 — 캠페인 중지·지급 보류

- **캠페인 중지**: `POST /internal/v1/kill-switch` 또는 `POST /internal/v1/emergency-stop` (재개 `emergency-resume`). 중지 후 클라이언트 `GET /v1/ad-decision`이 광고를 내리는지 확인한다.
- **지급 보류**: 의심 건은 **`교환 대기(REQUESTED)` 상태로 두고 `deliver`하지 않는다.** 운영자 검토(예: MULTI_ACCOUNT_RISK 신호) 후 정상이면 `deliver`, 아니면 `cancel`한다. 다계정 신호만으로 자동 차단·부정 처리하지 않는다.

**확인(불변식)**: 중지·보류가 원장을 손상시키지 않고, 재개·지급 재개가 안전하게 이뤄진다.

## 6. 익명 광고주 성과 보고서 샘플

`GET /internal/v1/analytics/summary|breakdown|csv`로 노출·유효 노출·클릭·CTR·거절 사유를 **집계값만** 뽑아 샘플 보고서를 만든다. 사용자·기기·토큰 등 원시 식별자는 포함하지 않는다. 이 값을 리허설 리포트의 `advertiserReport` 블록에 채운다.

## 7. 데이터 정리

리허설 전용 캠페인·QA 계정·교환·원장 항목을 정리 절차에 따라 격리·정리한다. 운영 알파 데이터와 섞지 않는다.

---

## 8. 리포트 생성

```bash
npm run qa:rehearsal:init -- rehearsal.json   # 템플릿 생성
# rehearsal.json을 관측값으로 채운다 (commit·campaignKey·분리 게이트·광고주 집계·케이스 결과)
npm run qa:rehearsal:report -- rehearsal.json rehearsal-report.md
```

- 스크립트는 `houseRevenueKrw`·`testRevenueKrw`·`testUnpaidRewardLiabilityKrw`가 **정확히 0**이 아니면 거부한다(분리 위반).
- 모든 필수 케이스가 PASS여야 **GO**로 판정한다. 하나라도 FAIL/BLOCKED면 NO-GO.
- 이메일·토큰·인증정보 원문, 자유 텍스트 사유 코드는 기록을 거부한다.

리포트가 GO이면 CLAW-64 알파 E2E와 함께 테스터 초대의 근거로 삼는다.
