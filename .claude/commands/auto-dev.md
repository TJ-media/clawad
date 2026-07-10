인자로 받은 Jira 이슈 키($ARGUMENTS)에 대해 자동 개발 파이프라인을 실행한다.

인자가 없으면 "이슈 키를 인자로 전달하세요. 예: /auto-dev CLAW-4"라고 출력하고 종료한다.
인자가 여러 개면(쉼표/공백 구분) 각 이슈에 대해 **한 번에 하나씩** 전체 파이프라인을 순차 실행한다.

파이프라인: 0.타겟 판별 → 1.이슈 파악/계획 → 2.구현 → 3.검증(빌드∥리뷰) → 4.실행 검증 → 5.커밋/PR → 6.알림/기록

가드레일: 빌드 실패와 리뷰 위반은 각각 **최대 2회**까지 수정 후 재검증한다. 초과 시 실패로 종료하고 6단계에서 실패 알림을 보낸다. 진행 상황은 태스크 도구(TaskCreate/TaskUpdate)로 추적한다.

---

## 0단계: 타겟 판별 (CLIENT / SERVER / INFRA)

Jira 이슈 제목의 접두사로 작업 대상을 결정한다: `[CLIENT]` / `[SERVER]` / `[INFRA]`. 접두사가 없으면 이슈 본문으로 추정하되, 불확실하면 사용자에게 질문한다.

REPO_DIR은 하드코딩하지 않고 **현재 머신에서 탐색**한다:

1. 현재 세션 루트가 clawad 레포면 그대로 사용
2. 아니면 `C:\Users\SSAFY\Desktop\TJmedia\clawad` 확인 (존재 + `git rev-parse` 성공 기준)
3. 실패하면 사용자에게 레포 경로를 질문한다.

이후 모든 git/빌드/테스트 명령은 반드시 REPO_DIR에서 실행한다.

---

## 1단계: 이슈 파악 및 계획

Atlassian MCP로 이슈를 조회한다 (cloudId: `d4081ac1-010a-45f5-8241-d9d67209e21b`, 실패 시 getAccessibleAtlassianResources로 재확인).

- 이슈 상태를 "진행 중"으로 전환한다. transition ID를 하드코딩하지 말고 `getTransitionsForJiraIssue`로 조회해 이름이 "진행 중"인 전환을 사용한다.
- 이슈 제목, 구현 사항, 필요 API 엔드포인트를 파악한다.
- 이슈가 "결정 필요" 상태(선택지가 남아 있는 검토 일감)라면 구현하지 말고 사용자에게 결정을 요청한다.

**난이도 판별**: 이슈가 아래 중 하나라도 건드리면 HARD로 분류한다.
- 정산·수익 집계 로직 (원장 스키마, 멱등 키, 단가/배분율)
- 인증·인가 / 지급(포인트·상품권) 처리
- 어뷰징 탐지 / viewability 판정 로직

HARD 이슈는 2단계 구현 후 3단계 리뷰와 별개로, **opus 급 서브에이전트(claude-opus-4-8)에 설계 검토를 추가 위임**한다 (변경 파일 경로와 이슈 요약을 전달).

구현 계획(PLAN)을 수립한다. PLAN은 5단계에서 PR 본문의 "구현 계획" 섹션에 그대로 들어간다.

```
PLAN:
- 수정할 파일 / 생성할 파일
- 구현 접근법 (핵심 로직 한 줄)
- 재사용 가능한 기존 코드 (client의 readJson/원장 로직, server의 라우트 패턴)
- 주의사항 (엣지 케이스, 핫패스 성능, BOM, 멱등성)
```

현재 세션의 memory 디렉토리에 `skills.md`가 있으면 유사한 이슈 패턴을 참고한다.

---

## 2단계: 코드 구현

### 브랜치 준비 (REPO_DIR에서)

```bash
git fetch origin
git checkout -b {feat|fix|chore}/{이슈키 소문자}-{영문-슬러그} origin/develop
```

브랜치가 이미 존재하면 checkout으로 전환한다. 재시도로 재진입한 경우 실패 원인(빌드 오류/리뷰 지적)을 반드시 함께 수정한다.

### 구현 규칙

- `.claude/rules/clawad.md`를 따른다. 핵심: 핫패스 무네트워크, 멱등 키, append-only 원장, BOM 방어, 무의존성.
- TARGET=CLIENT: statusline 핫패스에 코드를 추가할 때는 실행 시간 영향을 항상 검토한다.
- TARGET=SERVER: 새 엔드포인트는 잘못된 입력에 4xx JSON으로 응답해야 한다. 크래시 금지.
- 테스트를 작성/보강하는 이슈면 test/에 node:test로 작성한다.

---

## 3단계: 빌드 검증 + 코드 리뷰 (병렬)

`Agent` 도구로 두 서브에이전트를 **동시에** 호출한다:
- `build-validator` (haiku) — 프롬프트: "REPO_DIR에서 npm run lint와 npm test를 실행하고 결과를 보고해줘"
- `clawad-reviewer` (opus) — 프롬프트에 **변경된 파일의 경로 목록만** 전달한다. 파일 내용을 복붙하지 않는다 (에이전트가 직접 읽는다).

### 결과 평가

- 빌드 실패: BUILD_RETRIES < 2면 +1 하고 2단계로 돌아가 수정. 초과 시 실패 종료.
- 리뷰 위반(REVIEW_FAIL): REVIEW_RETRIES < 2면 +1 하고 2단계로 돌아가 수정. 초과 시 실패 종료.
  - 단, 리뷰어가 "문서-코드 불일치 의심"으로 보고한 항목은 코드 수정 대상이 아니라 사용자 보고 대상이다.
- 둘 다 통과 → 4단계.

---

## 4단계: 실행 검증 (빌드 통과 ≠ 동작함)

### TARGET=CLIENT

1. statusline을 실제로 실행한다: `echo '{}' | node client/statusline.js` — 광고 한 줄이 출력되고 exit 0인지 확인.
2. 시간 조작(state.json의 shownAt 백데이트)으로 viewability 집계·로테이션이 기대대로 동작하는지 확인한다.

### TARGET=SERVER

서버를 백그라운드로 띄우고 변경/신규 엔드포인트를 1회 호출해 기대 응답(2xx/4xx)을 확인한 뒤 종료한다.

실패 시 3단계의 빌드 실패와 동일하게 취급한다 (BUILD_RETRIES 공유).

---

## 5단계: 커밋 및 PR 생성

REPO_DIR에서 변경 파일만 명시적으로 `git add` (`git add .` / `-A` 금지) → 커밋 → 푸시 → `gh pr create --base develop`.

- 커밋 메시지: `{feat|fix|chore}: {이슈 제목 한 줄 요약} ({ISSUE_KEY})` — AI 관련 문구(Co-Authored-By 등) 금지
- PR 본문: 개요 / **구현 계획(1단계 PLAN 전문)** / 변경사항 / 검증 결과(빌드·테스트·실행 검증) / Jira 링크 `https://whatsuphouse.atlassian.net/browse/{ISSUE_KEY}`
- `gh` CLI가 없으면 커밋·푸시까지만 하고 PR 생성 URL(`https://github.com/TJ-media/clawad/compare/develop...{브랜치}`)을 사용자에게 안내한다.

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
