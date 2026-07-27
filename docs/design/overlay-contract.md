# 오버레이 클라이언트 계약 (CLAW-86)

clawad-overlay(AGPL-3.0, clawd-on-desk 포크)와 clawad(비공개) 사이의 통신 계약을 정의한다.
카피레프트 격리를 위해 두 저장소는 코드를 공유하지 않으며, 여기 명시된 협약으로만 상호작용한다.

- 상태: **v0.2** — 노출 이벤트 전달 방식 확정(CLAW-90, 아래 §3.2·§3.3). 남은 미결은 오버레이측 구현(CLAW-119)뿐
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

**데이터 디렉터리 탐색 (CLAW-119).** 아래 모든 경로는 clawad 로컬 데이터 디렉터리 기준이다.
clawad는 `CLAWAD_DATA` → (배포 설치본) `~/.clawad` → (저장소 체크아웃) `<repo>/data` 순으로 정한다
(`client/distribution-config.js`). 오버레이는 clawad 설치 경로를 추측하지 않는다 —
`CLAWAD_DATA`가 있으면 그것을, 없으면 `~/.clawad`를 쓴다. 개발 체크아웃과 붙일 때는
`CLAWAD_DATA`를 지정한다. 디렉터리가 없으면 광고 기능만 비활성이고 펫은 정상 동작한다.

| 파일 | 내용 | 비고 |
|---|---|---|
| `data/bundles.json` | 광고 번들(표시 텍스트·serveToken·만료) | 광고 선택 규칙은 statusline과 동일해야 함(동시 표시 시 같은 광고 — CLAW-91) |
| `data/work-state/*.json` | 훅 기반 활동 상태 | idle/active 판정. `overlay.idleThresholdMs` 적용 |
| `data/overlay-policy.json` | 정책 캐시 (아래 2.1) | 정책값 하드코딩 금지(규칙 §5). 파일이 없으면 statusLine 값으로 폴백하지 않고 광고 기능만 비활성 |

읽기 규약: 모든 JSON은 BOM(U+FEFF) 제거 후 파싱. 파일 부재·손상 시 크래시 없이 광고 없는 펫 렌더로 fallback(규칙 §8).

### 2.1 `data/overlay-policy.json` 정책 캐시 (CLAW-90 확정)

오버레이는 별도 프로그램이라 `policy/` 파일과 `loadPolicy()`에 접근하지 않는다. 표시에 필요한
값만 sync가 매 주기 이 캐시로 넘긴다.

```json
{ "version": 1, "overlay": { "adRotateMs": 15000, "idleThresholdMs": 60000, "maxWidthPx": 420 },
  "impression": { "minViewMs": 5000 }, "updatedAt": 1790000000000 }
```

- **단가·배분율·상한·CPM은 넘기지 않는다.** 클라이언트는 금액을 다루지 않는다(규칙 §2).
- `version`이 다르거나 값이 양의 정수가 아니면 오버레이는 광고 기능을 켜지 않는다. 정책값을 추측하거나
  기본값으로 넘겨짚지 않는다.
- 캐시가 없으면(= sync가 아직 돌지 않았거나 정책 로드 실패) 광고 없이 펫만 렌더한다.

## 3. 로컬 파일 협약 — 오버레이가 쓰는 것

| 파일 | 내용 | 상태 |
|---|---|---|
| `data/surface.lock` | 단일 노출 스트림 락 | **포맷 확정 (아래 3.1)** — statusline측 감지는 CLAW-91에서 구현됨 |
| 노출 이벤트 전달 | 광고를 표시한 **사실**(표시 구간) | **포맷 확정 (아래 3.2)** — 스풀 파일. 수거·채번·원장 append는 clawad가 한다 |

**전달 방식 결정 (CLAW-90).** 스풀 파일로 넘기고, 수거는 clawad가 한다. 로컬 IPC(소켓·named pipe)는
채택하지 않았다 — sync는 상주 데몬이 아니라 OS 스케줄러가 5분 주기로 띄우는 단발 프로세스라
(`client/sync-scheduler.js`) 붙을 상대가 없고, 상주 데몬을 신설하면 유실 대비 큐를 또 만들어야 한다.
스풀만 쓰면 수거가 최대 한 주기 늦으므로, 오버레이가 스풀을 쓴 직후 **수거 커맨드를 직접 실행**해
즉시성을 얻는다(§3.3). 트리거 실패는 유실이 아니라 지연이며, 다음 주기 sync가 같은 수거를 돌린다.

sequence 채번·원장 append·머신 ID는 **clawad가 전담한다**(CLAW-86 "위임" 결정). 오버레이는
`sequence`·`machineId`·`clientVersion`·`userId`를 만들지 않는다 — 스풀에 그런 키가 있어도 수거가
무시한다. 서버로 전송되는 필드는 기존 8개를 넘지 않는다: serveToken, sequence, machineId,
startedAt, endedAt, renderStarted, userId, clientVersion (privacy-design §1).

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

### 3.2 `data/overlay-events/` 스풀 포맷 (CLAW-90 확정)

오버레이는 광고 한 건의 표시가 끝날 때(또는 로테이션으로 교체될 때) 파일 **한 건**을 쓴다.

```json
{ "version": 1, "serveToken": "...", "renderStarted": 1790000000000,
  "displayStartedAt": 1790000000000, "displayEndedAt": 1790000006500 }
```

| 필드 | 필수 | 의미 |
|---|---|---|
| `version` | ✅ | 스풀 스키마 버전. 현재 `1`. 다른 값은 폐기된다 |
| `serveToken` | ✅ | 표시한 번들의 토큰. **수거의 중복 판정 키**이며 단일 사용이다 |
| `renderStarted` | ✅ | 광고가 화면에 처음 뜬 시각(ms). `displayStartedAt` 이하여야 한다 |
| `displayStartedAt` / `displayEndedAt` | ✅ | **광고 표시 구간**(ms). 세션 시작·종료 시각이 아니다 |

- 파일명은 `[0-9a-f]{32}.json`(랜덤 16바이트 hex). 그 외 이름은 우리 파일이 아니므로 수거가 읽지도 지우지도 않는다.
- 쓰기는 원자적으로 한다: 같은 디렉터리에 `*.tmp`로 쓰고 `rename`. 권한은 `0o600`. 수거는 `.tmp`를 무시한다.
- **오버레이가 하지 않는 것**: 채번, 머신 ID 생성, 활성 구간 판정, 최소 시청 시간 판정, 금액·상한·부정 여부 계산.

**수거 규칙 (`client/overlay-events.js`).** `data/ledger.lock`을 잡은 뒤 건별로 처리한다.

1. 스키마 위반 → 폐기(`MALFORMED`).
2. `serveToken`이 이미 원장에 있으면 폐기(`DUPLICATE`) — 수거는 at-least-once이고, 이 대조가 중복 인정을 막는다.
3. `bundles.json`에 없는 토큰이거나 캠페인 유형이 PAID/HOUSE/TEST가 아니면 폐기(`UNKNOWN_TOKEN`).
4. 유효 노출 구간 = **표시 구간 ∩ 활성 구간**. `work-state`의 모든 세션을 훑어 가장 긴 교집합을 쓰고,
   서로 떨어진 구간을 합치지 않는다. 길이가 `minViewMs` 미달이면 폐기(`BELOW_MIN_VIEW`).
5. 통과분만 `sequence`를 채번해 원장에 append하고, 요약·`sequence.json`을 갱신한 뒤 토큰을 캐시에서 제거한다.
   `ledger-summary-pending.json`(의도 파일) 패턴은 statusline과 동일하다 — 복구가 대기 중이면 수거를 건너뛴다.
6. 일일 상한·부정 여부는 수거가 판정하지 않는다. 서버 검증이 최종 판정이다.

**스풀 위생.** 보존기간·파일 수 상한은 정책값이다(§4). 초과분은 오래된 것부터 폐기해 오프라인이
길어져도 디렉터리가 무한히 자라지 않게 한다.

### 3.3 수거 트리거 `data/overlay-trigger.json` (CLAW-90 확정)

스풀만으로는 수거가 최대 한 sync 주기 늦는다. 즉시 반영을 위해 오버레이가 이 포인터를 읽어
수거 커맨드를 **best-effort로 1회 실행**한다. sync가 매 주기 갱신하므로 재설치 없이 항상 현재 설치본을 가리킨다.

```json
{ "version": 1, "node": "C:\\...\\node.exe", "script": "C:\\...\\client\\overlay-events.js",
  "args": ["collect"], "clientVersion": "0.1.8" }
```

- 오버레이측 요구사항: 파일이 없거나 `script`의 파일명이 `overlay-events.js`가 아니면 **실행하지 않고** 스풀만 남긴다.
  임의 경로를 그대로 실행하지 않는다. 실행은 하나씩만(동시 다중 실행 금지), 실패·타임아웃은 무시한다.
- 이 파일은 로컬 협약이며 서버로 전송하지 않는다. 사용자 파일 경로가 아니라 클로애드 설치 경로만 담는다.
- 수거는 `clawad collect-overlay-events`(= `node client/overlay-events.js collect`)로도 수동 실행할 수 있다.

## 4. 정책값 (CLAW-86 확정)

`policy/reward-policy.default.json`의 `overlay` 섹션:

| 키 | 의미 | 불변식 |
|---|---|---|
| `adRotateMs` | 광고 교체 주기 | ≥ `impression.minViewMs` |
| `idleThresholdMs` | 무활동 → 유휴 전환 임계 | ≥ `impression.minViewMs` |
| `maxWidthPx` | 광고 표시 최대 폭 | 양의 정수 |
| `eventSpoolMaxFiles` | 스풀 파일 수 상한 (CLAW-90) | 양의 정수 |
| `eventSpoolRetentionMs` | 스풀 보존기간 (CLAW-90) | `overlay.adRotateMs` ≤ 값 ≤ `impression.maxUploadDelayMs` |

**단가·상한·`impression.minViewMs`·`frequency.*`는 statusline과 공유한다.** 서피스별 분리 금지
— 정산 복잡도 증가와 서피스 간 차익 유인을 막는다. 검증은 `policy/policy.js` validatePolicy.

## 5. 금지 사항 (요약)

- 오버레이의 서버 직접 통신·비밀 키 보유 금지 (네트워크는 sync 데몬 전용)
- 오버레이의 sequence 채번·원장 append·머신 ID 생성 금지 (표시 사실만 스풀에 남긴다 — §3.2)
- clawad ↔ clawad-overlay 코드 import·복사 금지 (파일 협약·API만)
- 8필드 외 이벤트 데이터 수집 금지, `[광고]` 표기 제거 금지
- upstream(clawd-on-desk) 아트워크 사용 금지 — 마스코트는 ClawAd 자체 제작만
