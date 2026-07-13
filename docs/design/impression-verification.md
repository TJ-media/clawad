# serveToken 기반 노출 검증 프로토콜 (CLAW-18)

> 상태: 확정 (v2). 클라이언트 자기 신고만으로 노출을 인정하는 구조를 폐기한다.
> **금액은 서버가 정책으로 계산한다. 클라이언트는 사실만 보고하고, 서비스 비밀 키를 보유하지 않는다.**
> 참조 구현: `server/lib/serveToken.js`, `server/lib/idempotency.js`, `server/lib/concurrentDedup.js`, `server/index.js`.

## 1. 전체 흐름

```
[sync 데몬]  GET /v1/ad-decision (인증)
     → 서버: 캠페인 선택 + serveToken(jti 포함) 서명 발급 + 광고 반환
     → 클라이언트: 로컬 캐시에 저장  (핫패스 statusline은 캐시만 읽음 = 무네트워크)
[statusline] 같은 광고 5초 이상 연속 렌더링 → 사실 이벤트 생성(로컬 원장)
[sync 데몬]  POST /v1/events (serveToken 포함, 인증·배치)
     → 서버: 토큰 서명·만료·사용자·기기 소유/상태·순번·중복·간격·캠페인상태·동시노출·상한 검증
     → ACCEPTED / REJECTED(+사유)
     → ACCEPTED만 과금·리워드 원장 반영
```

> 프리페치 순서: 운영은 광고를 **표시하기 전에** 토큰을 미리 받아 캐시한다. 현재 PoC(sync.js)는 데모를 위해 업로드 시점에 토큰을 받는다.

## 2. serveToken

- 서버가 발급하는 **서명된 단기 토큰**. 서버만 비밀 키를 가진다(시크릿 매니저, CLAW-27). 클라이언트는 토큰을 보관·제출만 한다.
- 페이로드: `{ jti, campaignId, creativeId, userId, machineId, campaignType, issuedAt, expiresAt }`.
- 발급 시 인증 세션의 `userId`와 요청 기기를 함께 서명한다. 제출 시 세션 사용자와 토큰 사용자가 다르면 `TOKEN_USER_MISMATCH`로 거절한다.
- 서명: HMAC-SHA256(서버 비밀키), 타이밍 안전 비교로 검증.
- **수명은 정책값**(`serveToken.ttlMs`, 기본 10분). 만료된 미사용 토큰은 재사용 불가.

### 프리페치·예약 제한
- 한 머신이 동시에 보유하는 미사용 토큰 수를 제한한다(`serveToken.maxUnusedTokensPerMachine`, 기본 3).
- 남은 유효 광고가 임계 이하(`prefetchRefillThreshold`, 기본 1)일 때 추가 프리페치한다.
- 예산을 예약한다면 토큰 만료 시 반드시 예약을 해제한다(멱등 작업). 예산 처리 방식은 [ledgers.md](ledgers.md) §예산 참조.

## 3. 멱등 키 (서버 생성)

클라이언트는 HMAC을 만들지 않는다(비밀 키 없음). 서버가 토큰 검증 후 내부적으로 생성한다:

```
idempotencyKey = SHA-256(tokenJti + ":" + machineId + ":" + sequence)
```

DB 유니크 제약으로 중복 적립·중복 과금을 원천 차단한다:

```
UNIQUE(token_jti, machine_id, sequence)
```

중복 이벤트(동일 요청 재전송)는 오류 없이 **멱등 처리**한다: 이전 처리 결과를 반환, 예산 중복 차감·리워드 중복 생성 없음.

## 4. 요청/응답 스키마

### GET /v1/ad-decision → 200
```json
{
  "serveToken": "<payloadB64>.<sig>",
  "ad": { "campaignId": "camp-1", "text": "백엔드 개발자 채용", "brand": "원티드", "label": "광고", "campaignType": "PAID" },
  "minViewMs": 5000
}
```

### POST /v1/events (클라이언트 → 서버) — 사실만
```json
[
  { "serveToken": "<...>", "sequence": 31, "machineId": "<가명 해시>",
    "startedAt": 1783670000000, "endedAt": 1783670006000, "clientVersion": "0.1.0" }
]
```
> `userId`는 이벤트 본문을 신뢰하지 않고 인증 세션에서 확정한다.
> **금지·무시 필드**: gross, userShare, rewardAmount, price 등 금액. 서버가 정책(CLAW-12)으로 계산한다. 클라이언트가 실어보내도 서버는 무시한다.

### POST /v1/events → 200
```json
{ "received": 10, "accepted": 7,
  "rejected": { "BAD_TOKEN": 1, "EXPIRED": 0, "BAD_INTERVAL": 1, "CONCURRENT_USER_IMPRESSION": 1 } }
```

## 5. 서버 검증 항목

1. **토큰 서명·만료**: 서명 일치 + `now ≤ expiresAt`. 실패 → `BAD_TOKEN` / `EXPIRED`.
2. **사용자·기기 바인딩**: 토큰 `userId`와 인증 세션이 다르면 `TOKEN_USER_MISMATCH`; 토큰과 본문의 `machineId`가 다르면 `BAD_TOKEN`.
3. **기기 재검증**: 제출 시에도 기기가 인증 사용자 소유이며 `ACTIVE`인지 확인한다. 실패 → `MACHINE_NOT_REGISTERED` / `MACHINE_NOT_ACTIVE`.
4. **필수 사실 필드**: serveToken, 정수 sequence, machineId. 누락 → `BAD_REQUEST`.
5. **멱등**: idempotencyKey 존재 시 이전 결과 반환(중복 미집계).
6. **viewability**: `endedAt − startedAt ≥ minViewMs(5000)`. 실패 → `BAD_INTERVAL`.
7. **동시 노출 dedup**(§6): 같은 userId의 승인 노출과 겹치면 → `CONCURRENT_USER_IMPRESSION`.
8. **캠페인 상태·유형**: 활성·승인·예산 잔여, PAID/HOUSE/TEST 자격(CLAW-6 §캠페인).
9. **상한·빈도**: **사용자 계정 단위**로 적용(기기별 아님) — 일일 유효 노출, 캠페인 빈도, 동일 광고 간격. 값은 정책.

## 6. 동시 노출 dedup (계정 단위)

동일 사용자 계정의 여러 기기에서 광고가 동시에 표시될 수 있다. 이벤트는 모두 수집하되 **한 건만** 유효 노출로 인정한다.

- 판정 기준: 같은 `userId`, `startedAt`~`endedAt` 구간이 허용 오차(`concurrentToleranceMs`, 기본 2000ms) 내에서 겹치면 동시 노출.
- 가장 먼저 시작된 정상 노출 한 건 인정, 시작 시각 동률이면 서버가 먼저 확정한 이벤트를 안정적 규칙으로 선택. 나머지 → `CONCURRENT_USER_IMPRESSION`.
- **동시 노출 거절은 제재가 아니다.** 사용자 제재 점수에 넣지 않는다. 과금·리워드·유효 노출·리포트 유효 노출에서 제외하되, 원본 수신 수와 무효 사유 통계에는 포함한다.
- 동시성 안전: 서로 다른 기기·서버 인스턴스의 거의 동시 도착, 오프라인 배치 업로드 순서 변화, 동일 이벤트 재전송에도 한 건만 승인. **PostgreSQL 트랜잭션 + 잠금/유니크 제약**으로 보장하며 메모리 변수·단일 프로세스 캐시에만 의존하지 않는다.

## 7. 클라이언트가 결정할 수 없는 값 (서버 전용)

노출 단가, 사용자 배분율, 최종 리워드 금액, 광고주 차감 금액, 캠페인 활성 여부, 일일 적립 상한, 부정 여부, 회원 잔액.

## 8. 백그라운드 세션 탐지 — 현 단계 유보

- 현재 Claude Code `statusLine` 입력만으로는 포커스/가시성(백그라운드 여부)을 신뢰성 있게 판단하기 어렵다.
- 따라서 **`BACKGROUND_SESSION`을 확정 거절 사유로 사용하지 않는다.** 향후 연구 또는 VS Code 확장에서만 지원 가능한 신호로 문서화한다.
- 현재 감지 가능한 신호로만 어뷰징 정책을 구성한다: 24시간 연속 이벤트, 비정상 이벤트 간격, 토큰 재사용, 순번 역행, 일일 상한 초과, 비정상 장시간 무중단 패턴.
- 여러 기기를 실제로 동시에 쓰는 정상 사용도 있으므로 동시 노출은 제재가 아니라 중복 미인정으로 처리한다(§6).

## 9. 구현 연계
- 클라이언트: CLAW-24 / 서버 검증: CLAW-6 / 원장: CLAW-17 / 어뷰징 테스트: CLAW-29 / 시크릿·킬스위치: CLAW-27.
