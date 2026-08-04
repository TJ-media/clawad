# 오버레이 클라이언트 계약 (CLAW-86)

clawad-overlay(AGPL-3.0, clawd-on-desk 포크)와 clawad(비공개) 사이의 통신 계약을 정의한다.
카피레프트 격리를 위해 두 저장소는 코드를 공유하지 않으며, 여기 명시된 협약으로만 상호작용한다.

- 상태: **v0.3** — 오버레이가 **유일한 광고 표시 창구**가 됐다(CLAW-134). statusline 광고는 폐지됐고
  `surface.lock`의 역할이 바뀌었다(§3.1). 노출 이벤트 전달 방식은 CLAW-90에서 확정(§3.2·§3.3)
- 경계 원칙: `clawad-overlay/docs/BOUNDARY.md`, 규칙 `.claude/rules/clawad.md` §8

## 0. 확정된 결정 (2026-07-25)

**client/*.js 재사용 방식 = (c) 위임.** 활동 감지·머신 ID·serveToken 관리·원장 append 로직은
clawad(client-cli)에 남긴다. AGPL로 공개하지 않고, 관찰 재구현도 하지 않는다.
오버레이는 아래 로컬 파일 협약과 서버 HTTP API 경유로만 이 기능들을 이용한다.

## 0.1 표시 창구 일원화 (CLAW-134, 2026-07-29)

**광고를 표시하는 것은 오버레이뿐이다.** clawad는 Claude Code의 `statusLine` 슬롯을 점유하지 않고,
`client/statusline*.js`는 제거됐다. 슬롯이 하나뿐이라 우리가 잡고 있으면 오버레이가 구독 쿼터
(`rate_limits`)를 읽을 수 없었다 — 그 값은 statusline stdin으로만 들어온다. 상류의 statusline
체이닝은 원격 배포 전용이라(로컬 Windows는 크로스 셸 러너가 필요하다) 대안이 되지 못했다.

따라 오는 결과:

- **오버레이가 없으면 광고도 적립도 없다.** 오버레이는 통합 설치(CLAW-133)로 CLI와 함께 들어간다.
- **인정 노출의 입구는 스풀 하나뿐이다**(§3.2). clawad에서 원장에 append하는 코드는 `client/overlay-events.js`뿐이다.
- **`[광고]` 표기 의무는 오버레이 표시가 진다**(표시광고법, 규칙 §3).
- **일시중지는 재고를 비워서 실현한다.** 오버레이는 별도 프로그램이라 `data/paused`를 읽지 않으므로,
  `clawad pause`가 `bundles.json`을 비우고 sync를 멈춘다 — 표시할 광고가 남지 않는다.

## 1. 아키텍처

```
Claude Code 훅 ──▶ client/work-activity.js ──▶ data/work-state/*.json ─┐ (읽기)
client/sync.js ──네트워크──▶ data/bundles.json ────────────────────────┤ (읽기)
                                                                       ▼
                          ┌────────────────────┐  스풀+트리거  ┌──────────────────┐
                          │ client/            │ ◀──파일 협약──│ clawad-overlay    │
                          │ overlay-events.js  │   surface.lock│ (유일한 표시 창구)│
                          │ (수거·채번·원장)   │──────────────▶│                   │
                          └────────────────────┘               └──────────────────┘
```

- **네트워크는 clawad의 sync 데몬만 사용한다.** 오버레이는 서버와 직접 통신하지 않는다.
  → 서버 HTTP API 변경 없음. 오버레이는 비밀 키·HMAC을 갖지 않는다(규칙 §2 유지).
- 오버레이가 얻는 모든 데이터는 sync 데몬이 프리페치한 로컬 캐시다. 표시 경로에 네트워크가 없다.

## 2. 로컬 파일 협약 — 오버레이가 읽는 것 (읽기 전용)

**데이터 디렉터리 탐색 (CLAW-119).** 아래 모든 경로는 clawad 로컬 데이터 디렉터리 기준이다.
clawad는 `CLAWAD_DATA` → (배포 설치본) `~/.clawad` → (저장소 체크아웃) `<repo>/data` 순으로 정한다
(`client/distribution-config.js`). 오버레이는 clawad 설치 경로를 추측하지 않는다 —
`CLAWAD_DATA`가 있으면 그것을, 없으면 `~/.clawad`를 쓴다. 개발 체크아웃과 붙일 때는
`CLAWAD_DATA`를 지정한다. 디렉터리가 없으면 광고 기능만 비활성이고 펫은 정상 동작한다.

| 파일 | 내용 | 비고 |
|---|---|---|
| `data/bundles.json` | 광고 번들(표시 텍스트·serveToken·만료) | 유일한 표시 창구이므로 선택 규칙은 오버레이가 정한다. serveToken은 단일 사용이다 |
| `data/work-state/*.json` | 훅 기반 활동 상태 | idle/active 판정. `overlay.idleThresholdMs` 적용 |
| `data/overlay-policy.json` | 정책 캐시 (아래 2.1) | 정책값 하드코딩 금지(규칙 §5). 파일이 없으면 기본값으로 폴백하지 않고 광고 기능만 비활성 |
| `data/reward-summary.json` | 표시용 리워드 수치·일일 상한 상태 (아래 2.2) | **표시 전용.** 오버레이는 이 값으로 어떤 계산도 하지 않는다 |
| `data/ad-inventory.json` | 광고 소진 신호 (아래 2.3) | 안내 문구를 띄울지 판단하는 플래그 |

읽기 규약: 모든 JSON은 BOM(U+FEFF) 제거 후 파싱. 파일 부재·손상 시 크래시 없이 광고 없는 펫 렌더로 fallback(규칙 §8).

### 2.1 `data/overlay-policy.json` 정책 캐시 (CLAW-90 확정)

오버레이는 별도 프로그램이라 `policy/` 파일과 `loadPolicy()`에 접근하지 않는다. 표시에 필요한
값만 sync가 매 주기 이 캐시로 넘긴다.

```json
{ "version": 1, "rewardShopUrl": "https://clawad.whatsup.house/",
  "overlay": { "adRotateMs": 15000, "adGapMs": 3000, "idleThresholdMs": 60000, "maxWidthPx": 420 },
  "impression": { "minViewMs": 5000 }, "activity": { "staleActiveMs": 3600000 },
  "updatedAt": 1790000000000 }
```

- **단가·배분율·상한·CPM은 넘기지 않는다.** 클라이언트는 금액을 다루지 않는다(규칙 §2).
- `version`이 다르거나 값이 양의 정수가 아니면 오버레이는 광고 기능을 켜지 않는다. 정책값을 추측하거나
  기본값으로 넘겨짚지 않는다.
- 캐시가 없으면(= sync가 아직 돌지 않았거나 정책 로드 실패) 광고 없이 펫만 렌더한다.

**`adGapMs`는 선택 항목이다 (CLAW-135).** 이유는 업데이트 경로가 서로 다르기 때문이다.

- 오버레이는 **자동 업데이트**(electron-updater)되고 CLI는 **수동 업데이트**(`clawad update`)다. 따라서
  "새 오버레이 + `adGapMs`를 모르는 구 CLI" 조합이 실제로 생긴다. 이때 광고를 끄면 사용자는 이유도 모른 채
  적립이 **영구히 0**이 된다 — 다음 sync를 기다려도 구 CLI는 이 키를 영영 쓰지 않는다.
- 그래서 **키가 없으면 간격 0**(계약 이전 판의 동작)으로 돌아간다. 이건 정책값을 추측하는 것이 아니다 —
  이 값은 우리가 신고하는 구간을 **줄이기만** 하므로, 없다고 해서 인정되면 안 될 노출이 인정되지 않는다.
  손해는 연속 노출이 서버에서 한 건만 인정되는 것뿐이고, 그게 정확히 이 값이 없던 시절의 상태다.
- **키가 있는데 양의 정수가 아니면** 손상된 캐시로 보고 광고를 켜지 않는다(위 일반 규칙 그대로).
- 캐시 `version`은 올리지 않았다. 올리면 반대 조합(새 CLI + 구 오버레이)에서 구 오버레이가 버전 불일치로
  광고를 꺼버려, 고치려던 문제를 방향만 바꿔 되살린다.

**`activity.staleActiveMs`도 같은 이유로 선택 항목이다 (CLAW-142).** 훅이 `Stop`을 보내지 못한 세션은
`work-state`에 `active: true`로 굳는다. 수거(`client/overlay-events.js`)는 `loadActivity`로 그 구간을
**`startedAt + staleActiveMs`에 끝난 것으로 닫아서** 읽는다. 오버레이의 표시 판정이 같은 규칙을 쓰지 않으면
좀비 세션 하나 때문에 "영원히 작업 중"으로 오판해, 보이지만 인정되지 않는 노출만 쌓이고 재고가 말라붙는다.

- 오버레이는 `active: true`인 세션을 볼 때 `now - startedAt`이 `staleActiveMs` 이내일 때만 작업 중으로 본다.
  넘겼으면 `startedAt + staleActiveMs`에 끝난 구간으로 취급해 `idleThresholdMs` 규칙을 그대로 적용한다.
- 키가 없으면(구 CLI) 기존 동작을 유지한다 — 광고를 끄지 않는다.

**`rewardShopUrl`도 선택 항목이다 (CLAW-166).** CLI 배포 설정의 `webOrigin`을 sync가 그대로 전달하며,
오버레이가 운영 origin을 하드코딩하거나 API origin에서 추측하지 않는다.

- 값이 유효한 `https` URL일 때만 트레이·마스코트 우클릭 메뉴에 리워드샵 진입점을 노출한다.
- 키가 없거나 `https`가 아니면 리워드샵 메뉴만 숨긴다. 선택 링크의 문제로 광고 정책 캐시 전체를
  무효화하거나 광고 표시를 중단하지 않는다.
- 클릭은 기본 브라우저로 열기만 한다. URL이나 클릭 사실을 원장·텔레메트리에 기록하지 않는다.
- 리워드샵은 지정 상품 교환 페이지이며 충전·양도·현금 환급 경로를 제공하지 않는다.

### 2.2 `data/reward-summary.json` 표시용 수치·상한 상태 (CLAW-150 확정)

sync가 서버 응답으로만 채운다. 두 응답(`/v1/rewards`, `prefetch-status`)이 같은 파일에 병합되므로
필드별로 갱신 시점이 다를 수 있다. `fetchedAt`은 마지막 쓰기 시각이다.

```json
{
  "version": 1,
  "verifyingPoints": 150,
  "confirmedPoints": 2000,
  "minimumRedemptionPoints": 1500,
  "dailyCapReached": true,
  "dailyCapResetsAt": "2026-08-01T00:00:00.000Z",
  "fetchedAt": 1785482702273
}
```

| 필드 | 뜻 | 표시 용어(규칙 §9) |
|---|---|---|
| `verifyingPoints` | 아직 확정·회수되지 않은 적립분 | **검증 중** |
| `confirmedPoints` | 확정 리워드 잔액 | **확정 리워드** |
| `minimumRedemptionPoints` | 최소 교환 기준(정책값) | 교환 기준 |
| `dailyCapReached` | 계정 단위 일일 상한 도달 여부 | — |
| `dailyCapResetsAt` | 상한 초기화 시각(정책일 경계, 기본 한국시간 06:00) | — |

**규칙 [CRITICAL]**

- **오버레이는 이 값으로 계산하지 않는다.** 단가·배분율·최종 금액은 클라이언트가 결정·계산·전송
  금지다(규칙 §2). "노출 N건 × 단가" 같은 식을 오버레이에 넣지 않는다. 서버가 준 수치를 **그대로 표시만** 한다.
- 표시 용어는 위 표를 따른다. "적립 예정"처럼 확정을 약속하는 표현을 쓰지 않는다 — 검증 중인
  적립은 거절될 수 있다. 화면 수익 표시가 "예상"임이 드러나야 한다(규칙 §2·§9).
- 키가 없으면(구 CLI) 해당 표시만 생략한다. 광고 기능을 끄지 않는다.

**`dailyCapReached: true`일 때**

- sync가 `bundles.json`을 비우므로 표시할 광고가 없다. 오버레이는 광고 대신 **안내 문구**를 띄울 수 있다.
- 안내 문구는 `[안내]`로 표기한다. **`[광고]`를 붙이지 않는다** — 광고가 아닌 것에 광고 표기를 하면 안 된다.
- **반대로 광고에 `[안내]`가 붙으면 표시광고법 위반이다(규칙 §3 [CRITICAL]).** 안내 문구 회전 큐와
  광고 번들 큐는 **서로 다른 소스**이며, `bundles.json`의 항목이 안내 큐에 들어갈 경로가 없어야 한다.

### 2.3 `data/ad-inventory.json` 광고 소진 신호 (CLAW-150 확정)

스키마는 **오버레이가 정했다.** clawad는 이 형태를 그대로 쓰고 임의로 바꾸지 않는다.

```json
{ "version": 1, "exhausted": true }
```

**`exhausted: true`는 일일 상한 도달만 뜻한다.** 재고가 비는 이유는 그 외에도 있지만
(`clawad pause`, 서버 킬스위치, sync 미실행, 캠페인 소진) 그때 "**오늘** 광고를 다 소진했어요"는
사실이 아니다. 안내 문구가 거짓이 되지 않도록 의미를 상한으로 좁혔다.

| 상황 | `bundles.json` | `exhausted` | 오버레이 표시 |
|---|---|---|---|
| 일일 상한 도달 | 비어 있음 | `true` | **안내 문구** |
| `clawad pause` | 비어 있음 | 그대로 | 광고 없음 (안내도 없음) |
| 서버 킬스위치 | 비어 있음 | 그대로 | 광고 없음 (안내도 없음) |
| sync 미실행·재고 없음 | 비어 있음/없음 | 파일 없을 수 있음 | 광고 없음 (안내도 없음) |
| 정상 | 있음 | `false` | 광고 |

- **파일이 없거나 `version`이 다르면 안내를 띄우지 않는다.** 구 CLI에서는 이 파일이 없다 — 그때
  안내를 띄우면 근거 없는 문구가 뜬다. 광고 기능 자체는 끄지 않는다(§2.1 `adGapMs`와 같은 원칙).
- 상한이 풀리면(정책일 롤오버, 기본 한국시간 06:00) 다음 sync가 `false`로 되돌린다. 경계는
  서버 정책값이므로 오버레이는 시각을 계산하지 않는다 — `dailyCapResetsAt`을 그대로 쓴다 (CLAW-151).
- **안내에 쓸 수치는 `reward-summary.json`(§2.2)에서 읽는다.** 이 파일은 플래그만 갖는다.
- 안내 문구는 `[안내]`로 표기한다. **`[광고]`를 붙이지 않는다.** 반대로 광고에 `[안내]`가 붙으면
  표시광고법 위반이다(규칙 §3 [CRITICAL]). 안내 큐와 광고 번들 큐는 서로 다른 소스이며,
  `bundles.json` 항목이 안내 큐로 들어갈 경로가 없어야 한다.

## 3. 로컬 파일 협약 — 오버레이가 쓰는 것

| 파일 | 내용 | 상태 |
|---|---|---|
| `data/surface.lock` | 광고 서피스 소유권 | **포맷 확정 (아래 3.1)** — CLAW-134 이후 오버레이 인스턴스 간 단독 소유 표시 |
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

### 3.1 `data/surface.lock` 포맷 (CLAW-91 확정, CLAW-134에서 역할 변경)

**역할이 바뀌었다.** 원래는 statusline과 오버레이 두 창구 사이의 중복 표시·이중 계상을 막는 장치였다.
statusline 광고가 폐지되면서(CLAW-134) 비소유자가 없어졌고, 지금 이 락이 막는 것은 **같은 기기에서
오버레이가 둘 이상 뜨는 경우**뿐이다 — 재설치 중 구/신 설치본이 겹치거나, 사용자가 실행 파일을
직접 두 번 띄우는 상황이다. clawad는 더 이상 이 파일을 표시 판단에 쓰지 않는다.

락을 가진 쪽이 광고 서피스의 소유자이고, 소유자만 광고를 렌더하고 스풀에 표시 사실을 남긴다.

```json
{ "pid": 12345, "startedAt": "2026-07-26T04:15:00.000Z", "owner": "overlay" }
```

| 필드 | 필수 | 의미 |
|---|---|---|
| `pid` | ✅ | 소유 프로세스 ID. 생존 여부가 소유 판정의 1차 기준이다 |
| `startedAt` | ✅ | 획득 시각(ISO 8601). `pid`를 읽을 수 없을 때만 만료 판정에 쓴다 |
| `owner` | — | 진단용 문자열(`"overlay"`). 판정에 쓰지 않는다 |

**획득·반환 (오버레이 = 유일한 소유자)**
- 획득은 배타 생성(`fs.openSync(file, 'wx', 0o600)`)으로 한다. 이미 있으면 소유자 생존을 확인하고, 죽었으면 지우고 재시도한다 — `client/sync-runtime.js`의 `acquireLock`과 같은 절차다.
- 락을 잡지 못한 인스턴스는 **광고를 렌더하지 않고 스풀도 쓰지 않는다.** 펫·대시보드 등 나머지 기능은 그대로 둔다.
- 정상 종료·일시중지 전환 시 반환(파일 삭제)한다. 비정상 종료로 남아도 `pid`가 죽어 있으므로 다음 인스턴스가 이어받는다 — 광고가 영구히 사라지는 상태는 생기지 않는다.
- 나이로 만료시키지 않는다. 상주 오버레이는 락을 며칠 들고 있다. `pid`를 읽을 수 없는 손상된 락만 `startedAt`(없으면 파일 mtime) 기준 15분으로 만료시킨다.

**clawad측**: 표시 판단에 쓰지 않는다. `client/sync-runtime.js`의 `lockHeldByLiveOwner()`는 진단·설치
확인 용도로만 남아 있고, 이 파일을 획득하거나 삭제하지 않는다.

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
| `displayStartedAt` / `displayEndedAt` | ✅ | **인정을 요청하는 표시 구간**(ms). 실제 표시 구간의 부분집합이며, 세션 시작·종료 시각이 아니다 |

- 파일명은 `[0-9a-f]{32}.json`(랜덤 16바이트 hex). 그 외 이름은 우리 파일이 아니므로 수거가 읽지도 지우지도 않는다.
- 쓰기는 원자적으로 한다: 같은 디렉터리에 `*.tmp`로 쓰고 `rename`. 권한은 `0o600`. 수거는 `.tmp`를 무시한다.
- **오버레이가 하지 않는 것**: 채번, 머신 ID 생성, 활성 구간 판정, 최소 시청 시간 판정, 금액·상한·부정 여부 계산.

**연속 노출 사이의 간격 (CLAW-135).** 서버는 동시 노출 판정 구간을 `impression.concurrentToleranceMs`만큼
양쪽으로 넓힌다. 로테이션이 표시 구간을 0ms 간격으로 붙여 만들면 **연속으로 본 광고가 서로**
`CONCURRENT_USER_IMPRESSION`으로 걸려 한 건만 인정된다. 그래서 오버레이는 다음을 지킨다.

- `displayStartedAt` = `max(실제 렌더 시각, 직전에 스풀로 남긴 displayStartedAt/EndedAt 중 종료 + overlay.adGapMs)`
- `renderStarted`는 **실제 첫 렌더 시각 그대로** 둔다. 표시 시작 진단(CLAW-71)의 의미가 유지된다.
- 간격은 **인정 구간에만** 둔다. **광고 표시를 끊지 않는다** — 패널은 계속 떠 있고 문구만 바뀐다.
  광고가 사라졌다 다시 나타나면 사용자 피로가 생기므로 UI에는 틈을 만들지 않는다.
- 지연 결과 구간이 `impression.minViewMs`에 못 미치면 스풀에 남기지 않는다(기존 규칙 그대로).
- 스풀로 남기지 못한(미달·폐기) 구간은 간격 기준점을 갱신하지 않는다. 서버가 본 적 없는 구간이라 충돌 대상이 아니다.

**수거 규칙 (`client/overlay-events.js`).** `data/ledger.lock`을 잡은 뒤 건별로 처리한다.

1. 스키마 위반 → 폐기(`MALFORMED`).
2. `serveToken`이 이미 원장에 있으면 폐기(`DUPLICATE`) — 수거는 at-least-once이고, 이 대조가 중복 인정을 막는다.
3. `bundles.json`에 없는 토큰이거나 캠페인 유형이 PAID/HOUSE/TEST가 아니면 폐기(`UNKNOWN_TOKEN`).
4. 유효 노출 구간 = **표시 구간 ∩ 활성 구간**. `work-state`의 모든 세션을 훑어 가장 긴 교집합을 쓰고,
   서로 떨어진 구간을 합치지 않는다. 길이가 `minViewMs` 미달이면 폐기(`BELOW_MIN_VIEW`).
5. 통과분만 `sequence`를 채번해 원장에 append하고, 요약·`sequence.json`을 갱신한 뒤 토큰을 캐시에서 제거한다.
   `ledger-summary-pending.json`(의도 파일)이 남아 있으면 sync의 원장 복구가 먼저다 — 수거를 건너뛴다.
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

### 3.4 로그인 실행 (CLAW-137)

오버레이는 이 포인터에서 **같은 디렉터리의 `login.js`를 끌어내** 로그인을 실행할 수 있다.
`node <dirname(script)>/login.js` 형태이며, `script`의 파일명이 `overlay-events.js`인지 확인하는
기존 검사를 통과한 뒤에만 유도한다 — 임의 경로를 실행하지 않는다는 성질이 유지된다.

**인증 로직은 clawad가 전담한다** (§0 위임). 오버레이는 OAuth 흐름·`auth.json` 쓰기 형식·토큰 갱신을
재구현하지 않는다. `login.js`는 loopback 서버를 열고 브라우저를 직접 띄우므로 터미널 없이 동작하고,
공급자 선택과 약관 동의는 웹 로그인 화면이 처리한다(CLAW-100).

오버레이가 상태를 판단할 때 읽는 파일은 둘이다. **읽기만 한다.**

| 파일 | 읽는 것 | 쓰지 않는 이유 |
|---|---|---|
| `data/auth.json` | **존재 여부만.** 토큰 값을 읽지 않는다 | 세션은 clawad 소유다 |
| `data/sync-state.json` | `lastError.code`·`lastSuccessAt` | sync 상태는 clawad가 기록한다 |

`lastError.code`로 구분하는 상태:

| code | 표시 |
|---|---|
| `LOCAL_AUTH_MISSING` · `LOCAL_AUTH_INVALID` | 로그인이 필요하다 |
| `CONSENT_REQUIRED` | 약관·방침이 개정되어 재동의가 필요하다 |
| `SESSION_EXPIRED` | 세션이 만료됐다 — 다시 로그인해야 한다 |
| `NETWORK_UNAVAILABLE` · `SERVER_UNAVAILABLE` | 일시적 장애다. 로그인 안내를 띄우지 않는다 |

### 3.5 오버레이 갱신 실행 (CLAW-160)

오버레이는 §3.3의 포인터에서 **같은 디렉터리의 `overlay-update.js`를 끌어내** 자기 갱신을 clawad에
맡긴다. §3.4(로그인)와 같은 방식이며, `script`의 파일명이 `overlay-events.js`인지 확인하는 기존
검사를 통과한 뒤에만 유도한다 — 임의 경로를 실행하지 않는다는 성질이 유지된다.

**왜 오버레이가 스스로 받지 않는가.** 무서명 빌드는 브라우저로 받으면 macOS가
`com.apple.quarantine`을 붙여 Gatekeeper가 실행을 막는다. clawad가 Node로 받아 `ditto`로 풀면
애초에 붙지 않는다(`client/overlay-install.js` 헤더, CLAW-92). 그리고 실행 중인 앱이 자기 번들을
교체하면 실패 시 되돌릴 주체가 없다 — 교체 주체가 앱 밖에 있어야 구 버전을 복구할 수 있다.

절차:

1. 오버레이가 `node <dirname(script)>/overlay-update.js`를 **분리 실행**한다 (완료를 기다리지 않는다)
2. 오버레이가 스스로 종료한다 — 자기 정리(서피스 락 해제 등)를 자기가 한다
3. clawad가 프로세스 종료를 기다린 뒤 번들을 교체하고 다시 띄운다

| 상황 | clawad의 처리 |
|---|---|
| 한도(60초) 안에 종료하지 않음 | 교체하지 않고 종료 (`busy`). 반쯤 교체된 앱을 만들지 않는다 |
| 설치본이 이미 최신 | 내려받지 않고 다시 띄우기만 한다 (`up-to-date`) |
| 다운로드·검증·교체 실패 | 구 번들이 제자리에 남고 다시 띄운다 |

- 교체는 설치 폴더 **안에서** 스테이징한 뒤 `rename`으로 바꾼다. `os.tmpdir()`이 다른 볼륨이면
  `rename`이 EXDEV로 실패하고, 덮어쓰기로 하면 구 버전에만 있던 파일이 남아 두 버전이 섞인다.
- **Windows는 이 경로를 쓰지 않는다.** NSIS는 electron-updater가 서명 없이도 설치까지 하므로
  clawad가 낄 이유가 없다.
- CLI가 없거나 트리거 파일이 없으면 오버레이는 릴리스 페이지 안내로 되돌아간다.

## 4. 정책값 (CLAW-86 확정)

`policy/reward-policy.default.json`의 `overlay` 섹션:

| 키 | 의미 | 불변식 |
|---|---|---|
| `adRotateMs` | 광고 교체 주기 | ≥ `impression.minViewMs` |
| `adGapMs` | 인정 구간 사이 간격 (CLAW-135). CLI 정책에는 필수, 오버레이가 읽을 때만 선택(§2.1) | > `impression.concurrentToleranceMs`, `adRotateMs - adGapMs` ≥ `impression.minViewMs` |
| `idleThresholdMs` | 무활동 → 유휴 전환 임계 | ≥ `impression.minViewMs` |
| `maxWidthPx` | 광고 표시 최대 폭 | 양의 정수 |
| `eventSpoolMaxFiles` | 스풀 파일 수 상한 (CLAW-90) | 양의 정수 |
| `eventSpoolRetentionMs` | 스풀 보존기간 (CLAW-90) | `overlay.adRotateMs` ≤ 값 ≤ `impression.maxUploadDelayMs` |

**단가·상한·`impression.minViewMs`·`frequency.*`는 `overlay` 섹션에 두지 않는다.** 서피스별 분리 금지
— 정산 복잡도 증가와 서피스 간 차익 유인을 막는다. 검증은 `policy/policy.js` validatePolicy.

## 5. 금지 사항 (요약)

- 오버레이의 서버 직접 통신·비밀 키 보유 금지 (네트워크는 sync 데몬 전용)
- 오버레이의 sequence 채번·원장 append·머신 ID 생성 금지 (표시 사실만 스풀에 남긴다 — §3.2)
- clawad ↔ clawad-overlay 코드 import·복사 금지 (파일 협약·API만)
- 8필드 외 이벤트 데이터 수집 금지, `[광고]` 표기 제거 금지
- upstream(clawd-on-desk) 아트워크 사용 금지 — 마스코트는 ClawAd 자체 제작만
