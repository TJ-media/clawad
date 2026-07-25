# 오버레이 클라이언트 계약 (CLAW-86)

clawad-overlay(AGPL-3.0, clawd-on-desk 포크)와 clawad(비공개) 사이의 통신 계약을 정의한다.
카피레프트 격리를 위해 두 저장소는 코드를 공유하지 않으며, 여기 명시된 협약으로만 상호작용한다.

- 상태: **v0.1** — 확정 항목과 미결 항목(CLAW-90·91·119에서 상세화)을 구분해 표기
- 경계 원칙: `clawad-overlay/docs/BOUNDARY.md`, 규칙 `.claude/rules/clawad.md` §8

## 0. 확정된 결정 (2026-07-25)

**client/*.js 재사용 방식 = (c) 위임.** 활동 감지·머신 ID·serveToken 관리·원장 append 로직은
clawad(client-cli)에 남긴다. AGPL로 공개하지 않고, 관찰 재구현도 하지 않는다.
오버레이는 아래 로컬 파일 협약과 서버 HTTP API 경유로만 이 기능들을 이용한다.

## 1. 아키텍처

```
Claude Code 훅 ──▶ client/work-activity.js ──▶ data/work-state/*.json ─┐ (읽기)
client/sync.js ──네트워크──▶ data/bundles.json ────────────────────────┤ (읽기)
                                                                       ▼
                              ┌──────────────┐   surface.lock   ┌──────────────────┐
                              │ statusline   │ ◀──파일 협약──▶ │ clawad-overlay    │
                              │ (clawad)     │                  │ (별도 프로그램)   │
                              └──────────────┘                  └──────────────────┘
```

- **네트워크는 clawad의 sync 데몬만 사용한다.** 오버레이는 서버와 직접 통신하지 않는다.
  → 서버 HTTP API 변경 없음. 오버레이는 비밀 키·HMAC을 갖지 않는다(규칙 §2 유지).
- 오버레이가 얻는 모든 데이터는 sync 데몬이 프리페치한 로컬 캐시다 (statusline 핫패스와 동일 모델).

## 2. 로컬 파일 협약 — 오버레이가 읽는 것 (읽기 전용)

| 파일 | 내용 | 비고 |
|---|---|---|
| `data/bundles.json` | 광고 번들(표시 텍스트·serveToken·만료) | 광고 선택 규칙은 statusline과 동일해야 함(동시 표시 시 같은 광고 — CLAW-91) |
| `data/work-state/*.json` | 훅 기반 활동 상태 | idle/active 판정. `overlay.idleThresholdMs` 적용 |
| 정책 캐시 | `overlay.adRotateMs`·`idleThresholdMs`·`maxWidthPx` | 정책값 하드코딩 금지(규칙 §5). overlay 섹션 누락 시 statusLine 값 폴백 금지, 광고 기능 기동 실패 처리 |

읽기 규약: 모든 JSON은 BOM(U+FEFF) 제거 후 파싱. 파일 부재·손상 시 크래시 없이 광고 없는 펫 렌더로 fallback(규칙 §8).

## 3. 로컬 파일 협약 — 오버레이가 쓰는 것

| 파일 | 내용 | 상태 |
|---|---|---|
| `data/surface.lock` | 단일 노출 스트림 락(소유자·획득 시각·stale 기준) | 포맷은 CLAW-91(statusline측)·CLAW-119(오버레이측)에서 공동 확정 |
| 노출 이벤트 전달 | 유효 노출 구간의 8필드 이벤트 | **미결** — 후보: (안1) `data/overlay-events/` 스풀 파일을 sync 데몬이 수거·업로드, (안2) sync 데몬 로컬 IPC. CLAW-90에서 확정 |

이벤트 필드는 어느 안이든 기존 8개를 넘지 않는다: serveToken, sequence, machineId, startedAt,
endedAt, renderStarted, userId, clientVersion (privacy-design §1). sequence 채번이 필요한 안을
택할 경우 `data/sequence.json` 잠금 프로토콜(락 파일·재시도 규칙)을 이 문서에 명문화한다.

## 4. 정책값 (CLAW-86 확정)

`policy/reward-policy.default.json`의 `overlay` 섹션:

| 키 | 의미 | 불변식 |
|---|---|---|
| `adRotateMs` | 광고 교체 주기 | ≥ `impression.minViewMs` |
| `idleThresholdMs` | 무활동 → 유휴 전환 임계 | ≥ `impression.minViewMs` |
| `maxWidthPx` | 광고 표시 최대 폭 | 양의 정수 |

**단가·상한·`impression.minViewMs`·`frequency.*`는 statusline과 공유한다.** 서피스별 분리 금지
— 정산 복잡도 증가와 서피스 간 차익 유인을 막는다. 검증은 `policy/policy.js` validatePolicy.

## 5. 금지 사항 (요약)

- 오버레이의 서버 직접 통신·비밀 키 보유 금지 (네트워크는 sync 데몬 전용)
- clawad ↔ clawad-overlay 코드 import·복사 금지 (파일 협약·API만)
- 8필드 외 이벤트 데이터 수집 금지, `[광고]` 표기 제거 금지
- upstream(clawd-on-desk) 아트워크 사용 금지 — 마스코트는 ClawAd 자체 제작만
