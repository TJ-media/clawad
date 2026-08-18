# CLAUDE.md

이 문서는 Claude Code가 클로애드(clawad) 프로젝트에서 작업할 때 따라야 할 규칙을 정의한다.

---

## 0. 서비스 정의

**클로애드는 광고주가 구매한 개발자 대상 광고 인벤토리를 Claude Code/IDE 사용자에게 제공하고, 검증된 광고 매출의 일부를 비현금성 리워드로 배분하는 광고 매체 플랫폼이다.**

- kickbacks.ai의 **클린룸 독자 구현** — 원본 소스코드 열람·복제 절대 금지 (source-available 비오픈소스)
- 리워드는 비구매형·비양도형, 지정 상품(모바일 쿠폰) 교환 전용. 충전·양도·현금 출금 없음 (P2 별도 검토)
- 리워드 모델 B: 인정 노출 1,000회당 300P (광고주 CPM과 분리, 서버 정책으로 관리)

---

## 1. 기술 스택

- **서버(목표)**: NestJS + PostgreSQL(4원장·행 잠금) + Redis(rate limit·serveToken·상한 카운터) — 모듈형 모놀리스
- **클라이언트**: Node.js 내장 모듈만 (활동 감지 훅 + sync 데몬 + 오버레이 이벤트 수거)
- **현 상태**: PoC는 무의존성 Node (CLAW-2·3). P1에서 NestJS 구조로 전환
- **목표 구조**: `apps/`(api·admin-web·user-web·client-cli) + `packages/`(domain-ad·impression·billing·reward·redemption·user·abuse·shared-contracts)

## 2. 실행 명령어

```bash
npm run lint      # 구문 검사
npm test          # 스모크 테스트
npm run server    # PoC 광고 서버 (http://localhost:8787)
```

## 3. 아키텍처 핵심 규칙

상세는 `.claude/rules/clawad.md` (v2). 요약:

- **클라이언트 보안 경계**: 금액·단가·배분율·상한·부정 여부·잔액은 클라이언트가 결정 금지. 사실만 보고. 클라이언트는 HMAC/비밀 키를 갖지 않는다.
- **serveToken 검증**: 노출 인정은 서버 검증 통과분만. serveToken에 jti. **멱등 키는 서버 생성** = SHA-256(tokenJti:machineId:sequence). 실제 DB 제약은 `UNIQUE(idempotencyKey)` 하나이며, 이 해시가 tokenJti·machineId·sequence 조합의 유니크와 등가다.
- **계정·기기·동시노출**: 계정당 기기 최대 3대(정책값), 4대째 409. 상한은 계정 단위. 같은 계정 여러 기기 동시 노출은 한 건만 인정(CONCURRENT_USER_IMPRESSION, 제재 아님). 다계정은 위험 신호(MULTI_ACCOUNT_RISK)일 뿐 자동 차단 금지.
- **캠페인 유형**: PAID/HOUSE/TEST 과금·리워드 자격 강제. HOUSE·TEST는 매출·부채 미발생.
- **4원장 분리·append-only**: 잔액은 원장 합산으로만. balance 직접 수정 금지.
- **광고 표시는 오버레이 전용**: clawad는 `statusLine` 슬롯을 점유하지 않는다(CLAW-134). 표시 경로는 로컬 캐시만 읽고, `[광고]` 표기 필수.
- **정책값 서버 관리**: 리워드 단가·상한·간격은 `policy/reward-policy.default.json`(운영은 정책 테이블)에서만. 코드 하드코딩 금지, 불변식 검증(`policy/policy.js`).
- **프라이버시**: 수집 허용목록 외 데이터는 코드가 접근 자체를 못 하게 설계. 허용목록의 단일 기준은 실제 전송 스키마(`docs/legal/privacy-design.md` §1) — 클라이언트 전송 필드는 serveToken·sequence·machineId·startedAt·endedAt·renderStarted·userId·clientVersion 8개뿐(renderStarted는 CLAW-71 표시 시작 진단 신호, 선택적·판정 미사용). 하드웨어 식별자(MAC·시리얼·UUID)와 **접속 IP**는 제품 이벤트로 수집 금지, 머신 ID는 로컬 랜덤 가명값.
- **세무 미확정**: 세율·과세 기준 하드코딩 금지 (CLAW-13 서면 답변 대기).

## 4. Jira 연동

- 사이트: `https://whatsuphouse.atlassian.net` (cloudId: `d4081ac1-010a-45f5-8241-d9d67209e21b`), 프로젝트 키: `CLAW`
- 에픽: CLAW-9(P0 정책·설계) → CLAW-10(P1 폐쇄 알파) → CLAW-11(P2 확장). **P0 완료 전 P1 구현 착수 금지.**
- 일감 등록: `/create-jira`, 자동 개발: `/auto-dev {이슈키}`, 추천: `/jira-next`
- 이슈 접두사: `[CLIENT]` `[SERVER]` `[ADMIN]` `[REWARD]` `[SECURITY]` `[PRIVACY]` `[QA]` `[INFRA]` `[PRODUCT]` `[LEGAL]`
- 신규 이슈는 해당 에픽에 parent로 연결한다.

## 5. 작업 시 주의사항

- 변경은 최소 단위로. 기존 코드 스타일 우선.
- 정책 수치(300P/1,000회, 상한, CPM)는 코드에 하드코딩하지 않는다 — 서버 설정·정책 문서(CLAW-12)로만.
- [LEGAL]·[PRODUCT] 이슈는 코드가 아니라 문서 산출물 (docs/).
- **검증 스크립트가 `install.js`·`update.js`를 실행할 땐 `CLAWAD_SCHEDULER_DRY_RUN=1` 필수.** OS 스케줄러 이름공간은 전역이라 `CLAWAD_DATA` 격리로 보호되지 않는다 (CLAW-194·195 — 2026-08-11 실 기기 예약 작업 삭제 사고).

## 6. Git 브랜치 전략

**기능 브랜치 → `develop` → (운영 배포 시) `main`.** 2026-07-30에 이 흐름으로 정리했고 `develop`을 main과 동기화했다.

- `main` — **운영 배포 기준**. 릴리스를 자르는 브랜치다. `develop`에서만 머지한다
- `develop` — 통합 브랜치. 기능 브랜치의 PR 대상이다
- `{feat|fix|chore|docs}/{이슈키 소문자}-{영문-슬러그}` — `develop`에서 분기, `develop`으로 머지
- **두 브랜치 모두 직접 푸시 금지.** PR로만 올린다
- 운영 배포는 `develop` → `main` PR을 만들어 머지한 뒤, **main에서** 태그·릴리스를 만든다. 버전 상향도 기능 브랜치와 같은 경로를 탄다
- 두 레포(clawad·clawad-overlay)는 같은 흐름을 쓴다. 걸친 변경은 **같은 브랜치명**으로 각각 PR을 만들고 본문에서 서로 링크한다

## 7. 릴리스 규칙

상세 절차는 `docs/operations/client-distribution.md`. 여기 있는 것은 어긴 적이 있어서 규칙이 된 항목들이다.

- **두 저장소를 같은 번호로 함께 자른다** (CLAW-214, 0.2.0부터). clawad와 clawad-overlay는 사용자에게 하나의 "클로애드 버전"으로 보인다 — 번호가 어긋나면 오버레이 화면이 말하는 버전과 `clawad status`가 말하는 버전이 달라져 사용자가 자기 버전을 특정할 수 없다. **한쪽만 바뀐 릴리스에서도 양쪽 태그를 자른다.** 오버레이 재빌드 시 Electron·의존성을 함께 올리지 않으면 `runtimeId`가 유지돼 기존 사용자는 `app.asar` 7.2MB만 받는다 (CLAW-161) — 번호만 맞추는 릴리스가 비싸지 않은 이유다.
- **npm 게시는 손으로 하지 않는다** (CLAW-209). GitHub 릴리스를 공개하면 `.github/workflows/npm-publish.yml`이 그 릴리스의 tarball을 그대로 올린다. 재빌드하지 않는다 — 빌드하면 릴리스 자산과 다른 바이트가 레지스트리로 가고 "버전 고정 URL이 곧 무결성 계약"이라는 전제가 깨진다.
- **게시를 빠뜨리면 신규 설치자만 조용히 옛 버전을 받는다.** 기존 사용자는 `clawad update`로 정상 갱신되므로 아무도 눈치채지 못한다. 실제로 0.1.21·0.1.22가 그렇게 빠져 신규 설치자가 2주간 Codex 훅 없는 0.1.20을 받았다. 릴리스 후 `npm view @clawad/cli version`으로 확인한다.
- **`packages/clawad-alias`의 의존 범위를 릴리스마다 본다.** minor가 올라가면 범위(`^0.2.0`)와 별칭 버전을 함께 올리고 `npm 별칭 게시` 워크플로를 돌린다. 하지 않으면 `npx clawad`가 조용히 옛 클라이언트에 붙는다. `test/clawad-alias.test.js`가 이 대조를 강제한다.
- **`npm publish`에 넘기는 경로에는 `./`를 붙인다.** 없으면 npm이 `packages/clawad-alias`를 GitHub 저장소 축약형(`user/repo`)으로 읽고 ssh 접속을 시도하다 exit 128로 죽는다.
- 릴리스 빌드에 `CLAWAD_RELEASE_OVERLAY_MANIFEST_URL`을 빠뜨리지 않는다. 없으면 배포본이 오버레이 설치를 건너뛰고 **설치는 "성공"으로 끝나면서 광고도 적립도 발생하지 않는다** (CLAW-149).

## 8. 클라이언트 설치·제거 불변식

- **제거는 설치가 바꾼 것을 전부 되돌린다** (rules §7). 설치 고지가 그렇게 약속한다. 특히 **전역 `clawad` 명령 제거는 `uninstall()`의 마지막 단계**여야 한다 — `npm uninstall -g`가 지우는 디렉터리가 그 순간 실행 중인 코드다. 먼저 지우면 뒤따르는 지연 `require`가 죽고 오버레이·훅이 통째로 남는다 (CLAW-210). 그 뒤로 새 모듈을 require하지 않는다.
- **여러 번 실행되는 명령은 멱등해야 한다.** `install`은 "Codex를 나중에 설치했으면 다시 실행하라"고 안내하는 경로이고, `login`은 유효한 세션이 있으면 브라우저를 열지 않는다 (CLAW-213). 세션 확인은 만료 시각을 로컬에서 보지 말고 `/v1/auth/refresh`로 물어본다 — 탈퇴·토큰 폐기는 서버만 안다.
- **오래 기다리기 전에 할 일이 있는지 먼저 확인한다.** 오버레이 갱신이 버전 비교보다 앱 종료 대기를 먼저 해서, 이미 최신인데도 60초 뒤 실패했다 (CLAW-215). 오버레이는 트레이 상주가 정상 상태다.
- **전역 명령과 릴리스 런타임의 버전은 어긋날 수 있다.** 전역 명령 갱신이 릴리스 설치의 부수 효과라 한 번 실패하면 그대로 뒤처진다. `update`가 전역 명령 버전을 대조해 뒤처졌으면 다시 설치한다 (CLAW-211, 0.2.1) — 새로 부수 효과에 기대는 설치 단계를 넣을 땐 `update`에도 복구 경로를 같이 둔다.
- `~/.claude/settings.json`·`~/.codex/hooks.json`처럼 **`CLAWAD_DATA` 격리가 닿지 않는 전역 파일**을 만지는 코드는 격리 가드를 둔다. 검증 스크립트가 `install.js`·`update.js`를 실행할 땐 `CLAWAD_SCHEDULER_DRY_RUN=1`, 전역 명령은 `CLAWAD_GLOBAL_CLI_DRY_RUN=1`, **Claude 설정은 `CLAWAD_SETTINGS`**를 쓴다. 데이터 경로만 격리하고 `CLAWAD_SETTINGS`를 빠뜨리면 `install`·`uninstall`이 실패한다 (CLAW-221) — 그 가드가 없던 동안 격리한 줄 알고 돌린 검증이 실 기기의 훅 경로를 작업 중인 체크아웃으로 바꿔 놓았다.

## 9. Git 커밋 규칙

- 커밋 메시지: `{feat|fix|chore}: {한 줄 요약} ({이슈키})`
- 커밋 메시지에 AI 활용 관련 내용을 포함하지 않는다. (Co-Authored-By 등 금지)
