인자로 받은 Jira 이슈 키($ARGUMENTS)에 대해 자동 개발 파이프라인을 실행한다.

인자가 없으면 "이슈 키를 인자로 전달하세요. 예: /auto-dev CLAW-4"라고 출력하고 종료한다.
인자가 여러 개면(쉼표/공백 구분) 각 이슈에 대해 **한 번에 하나씩** 전체 파이프라인을 순차 실행한다.

파이프라인: 0.타겟 판별 → 1.이슈 파악/계획 → 2.구현 → 3.검증(빌드∥리뷰) → 4.실행 검증 → 5.커밋/PR → 6.알림/기록

가드레일: 빌드 실패와 리뷰 위반은 각각 **최대 2회**까지 수정 후 재검증한다. 초과 시 실패로 종료하고 6단계에서 실패 알림을 보낸다. 진행 상황은 태스크 도구(TaskCreate/TaskUpdate)로 추적한다.

---

## 0단계: 타겟 판별 (CLIENT / SERVER / INFRA) + 레포 범위

Jira 이슈 제목의 접두사로 작업 대상을 결정한다: `[CLIENT]` / `[SERVER]` / `[INFRA]`. 접두사가 없으면 이슈 본문으로 추정하되, 불확실하면 사용자에게 질문한다.

### 레포는 둘이다

| 레포 | 성격 | 기본 경로 |
|---|---|---|
| `clawad` | 서버·광고·4원장·리워드·CLI. 비공개, source-available | `~/Desktop/TJmedia/clawad` |
| `clawad-overlay` | 데스크탑 오버레이 앱(유일한 광고 표시 창구). public, AGPL-3.0 | `~/Desktop/TJmedia/clawad-overlay` |

경로는 하드코딩하지 않고 **현재 머신에서 탐색**한다: 현재 세션 루트가 해당 레포면 그대로 쓰고, 아니면 위 기본 경로를 확인한다(존재 + `git rev-parse` 성공). 실패하면 사용자에게 질문한다.

**`[CLIENT]` 이슈는 양쪽에 걸치는 경우가 흔하다.** 두 레포는 코드를 공유하지 않으므로(규칙 §8), 값은 서버 HTTP API와 로컬 파일 협약(`docs/design/overlay-contract.md`)으로만 건넌다. 그래서 "오버레이가 쓸 값을 clawad가 내려준다" 형태의 변경은 **양쪽 모두** 손대야 한다 (전례: CLAW-135 `adGapMs`, CLAW-142 `staleActiveMs`).

착수 전에 어느 레포를 건드릴지 확정하고, 이후 모든 git/빌드/테스트 명령은 **해당 레포 디렉터리에서** 실행한다.

---

## 1단계: 이슈 파악 및 계획

이슈를 조회한다 (cloudId: `d4081ac1-010a-45f5-8241-d9d67209e21b`).

- Atlassian MCP를 쓸 수 있으면 MCP로 조회한다.
- MCP가 없으면 REST로 조회한다. 자격증명은 `apps/api/.env`의 `ATLASSIAN_EMAIL`·`ATLASSIAN_API_TOKEN`.
  - 조회·생성·코멘트는 **`/rest/api/2/`** (위키 마크업). `/rest/api/3/`은 ADF를 요구해 400이 난다.
  - 검색은 `/rest/api/2/search`가 410이므로 **`/rest/api/3/search/jql`** 을 쓴다.
- 이슈 상태를 "진행 중"으로 전환한다. transition ID를 하드코딩하지 말고 `/transitions`로 조회해 이름이 "진행 중"인 것을 쓴다.
- 이슈 제목, 구현 사항, 필요 API 엔드포인트를 파악한다.
- 이슈가 "결정 필요" 상태(선택지가 남아 있는 검토 일감)라면 구현하지 말고 사용자에게 결정을 요청한다.
- **사용자가 "이 세션의 분석으로 진행"이라고 지시하면 재조회하지 않는다.** 이미 대화에서 원인 분석과 수정 범위가 확정된 경우가 이에 해당한다.

**난이도 판별**: 이슈가 아래 중 하나라도 건드리면 HARD로 분류한다.
- 정산·수익 집계 로직 (원장 스키마, 멱등 키, 단가/배분율)
- 인증·인가 / 지급(포인트·상품권) 처리
- 어뷰징 탐지 / 유효 노출(활성 구간·최소 시청 시간) 판정 로직

HARD 이슈는 2단계 구현 후 3단계 리뷰와 별개로 **opus 급 설계 검토를 추가로 받는다**. 서브에이전트에 위임할 때는 변경 파일 경로와 이슈 요약을 전달한다. 다만 **현재 세션이 이미 해당 코드를 깊게 다뤄 맥락을 갖고 있으면 직접 검토하는 편이 정확하다** — 콜드 스타트 에이전트는 맥락을 처음부터 다시 세운다.

구현 계획(PLAN)을 수립한다. PLAN은 5단계에서 PR 본문의 "구현 계획" 섹션에 그대로 들어간다.

```
PLAN:
- 수정할 파일 / 생성할 파일
- 구현 접근법 (핵심 로직 한 줄)
- 재사용 가능한 기존 코드 (client의 readJson/원장 로직, server의 라우트 패턴)
- 주의사항 (엣지 케이스, 표시 경로 성능, BOM, 멱등성, 레포 간 버전 skew)
```

현재 세션의 memory 디렉토리에 `skills.md`가 있으면 유사한 이슈 패턴을 참고한다.

---

## 2단계: 코드 구현

### 브랜치 준비 (건드릴 레포마다)

```bash
git fetch origin
git checkout -b {feat|fix|chore}/{이슈키 소문자}-{영문-슬러그} origin/main
```

**베이스는 `main`이다.** `develop`은 실질적으로 정체돼 있고(2026-07 기준 main보다 98커밋 뒤) 최근 PR은 전부 main으로 갔다. 양쪽 레포 모두 같다. 두 레포를 건드리면 **같은 브랜치명**을 쓰면 추적하기 쉽다.

브랜치가 이미 존재하면 checkout으로 전환한다. 재시도로 재진입한 경우 실패 원인(빌드 오류/리뷰 지적)을 반드시 함께 수정한다.

### 구현 규칙

- `.claude/rules/clawad.md`를 따른다. 핵심: 표시 경로 무네트워크, 멱등 키, append-only 원장, BOM 방어, 무의존성.
- **TARGET=CLIENT (clawad)**: 광고를 렌더하는 코드나 `statusLine` 슬롯 등록을 넣지 않는다 (CLAW-134). 훅(`work-activity.js`)은 `session_id`만 읽는다. 수거(`overlay-events.js`)에 네트워크 호출을 넣지 않는다.
- **TARGET=CLIENT (clawad-overlay)**: 정책값을 추측하지 않는다 — 정책 캐시에서만 읽는다. 다만 **새 정책 키는 선택 항목으로 둔다**: 오버레이는 자동 업데이트되고 CLI는 수동 업데이트(`clawad update`)라 "새 오버레이 + 구 CLI" 조합이 실제로 생기고, 그때 광고를 꺼버리면 적립이 영구히 0이 된다. 키가 없으면 기존 동작 유지, 있는데 형식이 틀리면 거절.
- **TARGET=SERVER**: 새 엔드포인트는 잘못된 입력에 4xx JSON으로 응답해야 한다. 크래시 금지.
- 테스트를 작성/보강하는 이슈면 `test/`에 node:test로 작성한다.
- **테스트는 개발자 PC 상태에 의존하면 안 된다.** 실제 `%LOCALAPPDATA%`·설치본·실행 중인 프로세스를 보는 코드는 테스트에서 환경변수로 격리한다 (전례: CLAW-134의 status 테스트가 오버레이 설치 여부에 따라 간헐 실패).

---

## 3단계: 빌드 검증 + 코드 리뷰 (병렬)

`Agent` 도구로 두 서브에이전트를 **동시에** 호출한다:
- `build-validator` (haiku) — 프롬프트: "{레포 경로}에서 검증 명령을 실행하고 결과를 보고해줘" (아래 레포별 명령 참고)
- `clawad-reviewer` (opus) — 프롬프트에 **변경된 파일의 경로 목록만** 전달한다. 파일 내용을 복붙하지 않는다 (에이전트가 직접 읽는다).

두 레포를 건드렸으면 각 레포에 대해 검증한다.

**서브에이전트를 쓸지 판단한다.** 현재 세션이 이미 해당 코드를 다뤄 맥락을 갖고 있으면 직접 `npm run lint && npm test`를 돌리고 규칙 대조도 직접 하는 편이 빠르고 정확하다. 위임은 맥락이 없을 때 값이 있다.

### 레포별 검증 명령

| 레포 | 명령 | 통과 기준 |
|---|---|---|
| `clawad` | `npm run lint`, `npm test` | 실패 0건 |
| `clawad-overlay` | `npm test` (`apps/client-desktop`에서) | **실패 33건이 기준선이다.** lint 스크립트는 없다 |

`clawad-overlay`에는 기존 실패 33건이 있다(`remote-ssh-*`·`state`·`theme` 계열). **이 수가 늘지 않았는지**로 판정한다 — 0건을 기대하면 안 된다. 약 22초 걸린다.

### 결과 평가

- 빌드 실패: BUILD_RETRIES < 2면 +1 하고 2단계로 돌아가 수정. 초과 시 실패 종료.
- 리뷰 위반(REVIEW_FAIL): REVIEW_RETRIES < 2면 +1 하고 2단계로 돌아가 수정. 초과 시 실패 종료.
  - 단, 리뷰어가 "문서-코드 불일치 의심"으로 보고한 항목은 코드 수정 대상이 아니라 사용자 보고 대상이다.
- 둘 다 통과 → 4단계.

---

## 4단계: 실행 검증 (빌드 통과 ≠ 동작함)

광고 표시 창구가 오버레이 하나로 바뀌면서(CLAW-134) 검증 방법도 바뀌었다. **`client/statusline.js`는 존재하지 않는다** — 그걸 실행하는 검증은 쓰지 않는다.

### TARGET=CLIENT — clawad

바꾼 경로에 맞는 것만 고른다.

- **훅**: `echo '{"session_id":"verify"}' | node client/work-activity.js start` 후 `data/work-state/`에 파일이 생기고 exit 0인지. 프롬프트·경로가 저장되지 않았는지 파일 내용으로 확인한다.
- **수거·원장**: 임시 데이터 디렉터리에 번들·work-state·스풀 파일을 만들고 `node client/overlay-events.js collect`를 돌려 인정/미인정 건수와 원장 append를 확인한다. 활성 구간과 표시 구간을 어긋나게 만들어 **미인정 경로도** 확인한다.
- **설치·상태**: `CLAWAD_DATA`·`CLAWAD_SETTINGS`·`LOCALAPPDATA`를 임시 경로로 격리해 `install.js`의 `install`/`status`/`uninstall`을 돌린다. 실제 `~/.claude/settings.json`을 건드리지 않는다.
- **정책 전달**: 정책 캐시(`data/overlay-policy.json`)에 값이 실제로 실렸는지 확인한다.

### TARGET=CLIENT — clawad-overlay

- 표시 로직은 `createAdRuntime({ dataDir })`을 **별도 프로세스로 직접 호출**해 검증한다. `tick()`은 파일을 쓰지 않으므로 실제 데이터 디렉터리에 대고 돌려도 안전하다.
- 판정 함수(`isWorkActive` 등)는 실제 `work-state`를 임시 디렉터리로 복사해 수정 전후 결과가 갈리는지 확인한다. 실기 데이터로 확인하면 회귀 근거가 분명해진다.
- Electron 앱 자체를 띄우는 검증은 하지 않는다. 빌드가 오래 걸리고, 실행 중인 사용자 오버레이를 죽이게 된다.

### TARGET=SERVER

서버를 백그라운드로 띄우고 변경/신규 엔드포인트를 1회 호출해 기대 응답(2xx/4xx)을 확인한 뒤 종료한다.

실패 시 3단계의 빌드 실패와 동일하게 취급한다 (BUILD_RETRIES 공유).

---

## 5단계: 커밋 및 PR 생성

각 레포에서 변경 파일만 명시적으로 `git add` (`git add .` / `-A` **금지**) → 커밋 → 푸시 → `gh pr create --base main`.

- **`git add -A`를 쓰지 않는 이유**: clawad에 커밋하면 안 되는 미추적 파일이 있다(`ClawAd_Logo.png`, `docs/product/ClawAd-service-intro.*`, `.claude/launch.json`). 디렉터리 단위 `git add docs/`도 이것들을 쓸어담으므로 주의한다.
- 커밋 메시지: `{feat|fix|chore}: {이슈 제목 한 줄 요약} ({ISSUE_KEY})` — AI 관련 문구(Co-Authored-By 등) 금지
- git author는 `TJmedia <oganesson12@hufs.ac.kr>`만 쓴다.
- **main 직접 푸시 금지.** 보호 규칙이 PR을 요구한다. 버전 상향도 PR로 올린다.
- PR 본문: 개요 / **구현 계획(1단계 PLAN 전문)** / 변경사항 / 검증 결과(빌드·테스트·실행 검증) / Jira 링크 `https://whatsuphouse.atlassian.net/browse/{ISSUE_KEY}`
- `gh` CLI가 없으면 커밋·푸시까지만 하고 PR 생성 URL(`https://github.com/TJ-media/{레포}/compare/main...{브랜치}`)을 사용자에게 안내한다.

### 두 레포를 건드린 경우

- 레포마다 PR을 하나씩 만들고 **본문에서 서로를 링크**한다. 링크한 PR 번호가 실제와 맞는지 생성 후 확인한다(먼저 만든 쪽 본문의 번호가 틀리기 쉽다).
- Jira 코멘트에 두 PR URL을 모두 남긴다.
- 오버레이가 새 정책 키를 소비하는 변경이면 **릴리스 순서 영향**을 PR 본문에 적는다. 키를 선택 항목으로 뒀다면 순서 무관임을 명시한다.

`clawad-overlay`의 `apps/client-desktop/.gitignore`는 **허용목록 방식**이다(`docs/**`·`scripts/*`가 통째로 무시되고 `!경로` 예외만 추적). 새 파일을 추가하면 예외를 함께 넣어야 커밋된다 — `git status`로 추적 여부를 반드시 확인한다.

성공 → PR_URL 저장 → 6단계. 실패 → FAILURE_REASON 기록 → 6단계.

---

## 6단계: 알림 + 스킬 누적

`notify.md`의 로직을 따른다.
- 성공: `/notify success {ISSUE_KEY} {PR_URL}`
- 실패: `/notify failure {ISSUE_KEY} {FAILURE_REASON}`

### 스킬 누적 (성공 시에만)

현재 세션의 memory 디렉토리의 `skills.md` 파일 끝에 항목을 추가한다.

```
### {ISSUE_KEY} | {이슈 제목 요약} | {오늘 날짜 YYYY-MM-DD}
- 타겟: {CLIENT / SERVER / INFRA} / 난이도: {NORMAL / HARD}
- 이슈 유형: {핫패스 / 집계·정산 / 서버 API / 인프라 / ...}
- 수정 파일: {변경 파일 목록}
- 핵심 접근법: {PLAN의 구현 접근법 한 줄}
- 재사용 포인트: {다음 유사 작업에서 참고할 내용}
```
