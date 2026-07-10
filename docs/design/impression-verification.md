# serveToken 기반 노출 검증 프로토콜 (CLAW-18)

> 상태: 확정 (v1). 클라이언트 자기 신고만으로 노출을 인정하는 PoC 구조를 폐기한다.
> **금액은 서버가 계산한다. 클라이언트는 사실만 보고한다.**

## 1. 전체 흐름

```
[sync 데몬]  GET /v1/ad-decision (인증 토큰)
     → 서버: 캠페인 선택 + serveToken 서명 발급 + 광고 번들 반환
     → 클라이언트: 로컬 캐시에 저장  (핫패스 statusline은 캐시만 읽음 = 무네트워크)
[statusline] 같은 광고 5초 이상 연속 렌더링 → impression 이벤트 생성(로컬 원장)
[sync 데몬]  POST /v1/events (serveToken 포함, 배치)
     → 서버: 토큰 서명·시간창·순번·중복·간격·캠페인상태·상한 검증
     → accepted / rejected(+사유) 판정
     → accepted: billing.capture + reward.accrue_pending (CLAW-17)
```

## 2. serveToken

- 서버가 `GET /v1/ad-decision` 응답 시 발급하는 **서명된 단기 토큰**.
- 페이로드(예): `{ campaignId, creativeId, userId, machineIdHash, nonce, issuedAt, notBefore, expiresAt }`.
- 서명: HMAC-SHA256(서버 비밀키). 키는 시크릿 매니저 관리(CLAW-27), 로테이션 지원.
- 저장: Redis에 `serveToken nonce → {상태, 사용횟수}` 단기 보관(만료 = expiresAt + 여유).

## 3. 멱등 키

```
impressionId = HMAC(serveToken + machineId + sequence)
```
- 클라이언트가 임의 문자열을 만들지 않는다. 같은 (토큰, 머신, 순번)은 항상 같은 id → `ad_event_ledger.impression_id` UNIQUE로 중복 차단.

## 4. 요청/응답 스키마

### GET /v1/ad-decision → 200
```json
{
  "serveToken": "<base64url signed>",
  "ad": { "campaignId": 123, "creativeId": 45, "text": "백엔드 개발자 채용", "brand": "원티드", "label": "광고" },
  "notBefore": "2026-07-10T05:00:00.000Z",
  "expiresAt": "2026-07-10T05:10:00.000Z",
  "minViewMs": 5000
}
```

### POST /v1/events (클라이언트 → 서버)
```json
[
  {
    "serveToken": "<...>",
    "type": "impression",
    "startedAt": "2026-07-10T05:00:03.000Z",
    "endedAt": "2026-07-10T05:00:09.000Z",
    "sequence": 31,
    "machineId": "<pseudonymous hash>",
    "clientVersion": "0.2.0"
  }
]
```
> **금지 필드**: gross, user, points, price 등 금액. 서버가 캠페인 정책(CLAW-12)으로 계산한다.

### POST /v1/events → 200
```json
{ "received": 10, "accepted": 7,
  "rejected": { "badToken": 1, "overCap": 1, "badInterval": 1, "expired": 0 } }
```

## 5. 서버 검증 항목

1. **토큰 서명**: HMAC 재계산 일치.
2. **시간창**: `notBefore ≤ startedAt`, `endedAt ≤ expiresAt`, `received_at`가 만료 유예 내.
3. **viewability**: `endedAt − startedAt ≥ minViewMs(5000)`.
4. **순번 연속성**: 같은 머신의 sequence가 단조 증가, 역행·중복 거부.
5. **간격 타당성**: 동일 머신 연속 이벤트가 물리적으로 불가능한 간격(예: 5초 미만 연속 완결)이면 거부.
6. **중복(멱등)**: impressionId 기존 존재 시 무시.
7. **캠페인 상태**: 활성·심사 승인·예산 잔여.
8. **상한**: 캠페인 20회/일/인, 동일 광고 10분 간격, 유효 노출 500회/일 (Redis 카운터).
9. **킬스위치**: 머신/회원/캠페인 차단 여부(CLAW-27).

거절 사유는 `ad_event_ledger.reject_reason`에 코드로 기록.

## 6. 클라이언트가 결정할 수 없는 값 (서버 전용)

노출 단가, 사용자 배분율, 최종 리워드 금액, 광고주 차감 금액, 캠페인 활성 여부, 일일 적립 상한, 부정 여부, 회원 잔액.

## 7. 토큰 재사용·수명 정책

- serveToken 1건 = 1 노출 슬롯 원칙. 정상 재렌더로 인한 다중 보고는 sequence로 구분하되, 상한·간격 규칙으로 과다 적립을 차단.
- 오프라인 누적: 서버 불통 시 클라이언트가 이벤트를 로컬 보관 후 재전송(토큰 만료 시 해당 이벤트는 rejected → 미적립, 사용자에게 불이익 아님).

## 8. 구현 연계
- 클라이언트: CLAW-24 / 서버 검증: CLAW-6 / 어뷰징 테스트: CLAW-29 / 시크릿·킬스위치: CLAW-27.
