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
| `data/surface.lock` | 단일 노출 스트림 락 | **포맷 확정 (아래 3.1)** — statusline측 감지는 CLAW-91에서 구현됨 |
| 노출 이벤트 전달 | 유효 노출 구간의 8필드 이벤트 | **미결** — 후보: (안1) `data/overlay-events/` 스풀 파일을 sync 데몬이 수거·업로드, (안2) sync 데몬 로컬 IPC. CLAW-90에서 확정 |

이벤트 필드는 어느 안이든 기존 8개를 넘지 않는다: serveToken, sequence, machineId, startedAt,
endedAt, renderStarted, userId, clientVersion (privacy-design §1). sequence 채번이 필요한 안을
택할 경우 `data/sequence.json` 잠금 프로토콜(락 파일·재시도 규칙)을 이 문서에 명문화한다.

### 3.1 `data/surface.lock` 포맷 (CLAW-91 확정)

광고 서피스는 한 번에 하나만 광고를 렌더하고 노출 이벤트를 방출한다. 락을 가진 쪽이 소유자다.

```json
{ "pid": 12345, "startedAt": "2026-07-26T04:15:00.000Z", "owner": "overlay" }
```

| 필드 | 필수 | 의미 |
|---|---|---|
| `pid` | ✅ | 소유 프로세스 ID. 생존 여부가 소유 판정의 1차 기준이다 |
| `startedAt` | ✅ | 획득 시각(ISO 8601). `pid`를 읽을 수 없을 때만 만료 판정에 쓴다 |
| `owner` | — | 진단용 문자열(`"overlay"`). 판정에 쓰지 않는다 |

**획득·반환 (오버레이 = 소유자, CLAW-119)**
- 획득은 배타 생성(`fs.openSync(file, 'wx', 0o600)`)으로 한다. 이미 있으면 소유자 생존을 확인하고, 죽었으면 지우고 재시도한다 — `client/sync-runtime.js`의 `acquireLock`과 같은 절차다.
- 정상 종료·**일시중지 전환 시 반드시 반환**(파일 삭제)해 statusline이 이어받게 한다.
- 비정상 종료로 락이 남아도 `pid`가 죽어 있으므로 statusline이 stale로 판정해 광고를 재개한다. 광고가 영구히 사라지는 상태는 생기지 않는다.

**감지 (statusline = 비소유자, CLAW-91 구현 완료)**
- `lockHeldByLiveOwner()`로 **읽기 전용** 판정만 한다. statusline은 락을 획득하거나 삭제하지 않는다.
- 보유 판정: `pid`가 유효하면 **프로세스 생존 여부만** 본다. 경과 시간으로 만료시키지 않는다 — 상주 오버레이는 락을 며칠 들고 있으므로 나이로 만료시키면 이중 표시·이중 계상이 된다.
- `pid`를 읽을 수 없는 락(손상·필드 누락)만 `startedAt`(없으면 파일 mtime) 기준 15분(`DEFAULT_STALE_MS`)으로 만료시킨다.
- 보유 중이면 statusline은 **프로세스를 띄우지 않고** 원래 statusLine 출력만 통과시킨다. 따라서 노출 이벤트도 만들지 않는다.

락은 1차 방어이고 최종 방어는 서버다. 서버는 이미 `userId` 기준 시간 겹침으로 동시 노출을 한 건만 인정하므로(`CONCURRENT_USER_IMPRESSION`) 이 협약 때문에 서버를 바꾸지 않는다.

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
