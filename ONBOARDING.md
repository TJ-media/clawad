# 클로애드(ClawAd) 온보딩 — 새 팀원용

환영합니다! 이 문서 하나로 ① 프로젝트가 뭔지 ② 지금까지 어떻게 왔는지 ③ 앞으로 뭘 할지 ④ 맥북 세팅 방법을 전부 이해할 수 있게 썼습니다.

> 진행 상황·분업 서술(§2·§4·§5)은 **2026-07-24 온보딩 시점 스냅샷**입니다. 최신 이슈 상태는 Jira CLAW 보드를 보세요. 규칙(§3·§7)은 현행 기준으로 유지합니다.

---

## 1. 클로애드가 뭔가요? (1분 요약)

**개발자용 광고 매체 플랫폼**입니다. Claude Code 같은 AI 코딩 도구를 쓰는 개발자 화면에 광고 한 줄을 보여주고, 광고를 본 사용자에게 **광고 매출 일부를 포인트(모바일 쿠폰 교환용)로 돌려주는** 서비스예요.

- 광고주가 광고를 사면 → 개발자 PC의 데스크탑 오버레이 앱에 `[광고]` 한 줄이 뜨고 → 서버가 "진짜 노출"인지 검증해서 → 노출 1,000회당 포인트를 적립해줍니다.
- 핵심 자산은 **서버**입니다: 광고 서빙, 부정 방지, 4개 장부(원장)로 돈 흐름 관리, 리워드 정산.

## 2. 지금까지 온 길 (스토리)

**1단계 — 기반 (P0·P1, 완료~마무리 중)**
정책 설계(P0)를 끝내고, 폐쇄 알파(P1)를 만들었습니다. NestJS 서버 + PostgreSQL + Redis, 광고 클라이언트(CLI + 데스크탑 오버레이), 운영자 콘솔, 소셜 로그인까지. 지금 P1은 **마지막 5개 이슈가 "검토 중"** 상태 — 리뷰만 통과하면 알파 완성입니다.

**2단계 — 마스코트 (P3 브랜딩 트랙, 완료 ✅)**
픽셀 랍스터 마스코트를 만들었습니다. 그리고 `clawd-on-desk`라는 인기 오픈소스 앱(화면 위에 떠다니는 "데스크탑 펫", GitHub 5.5k★)용 **클로애드 테마 v1.6.0**을 완성했어요 — 대기/생각/작업/수면 등 상태별 애니메이션, 미니모드, 클릭 리액션까지. 웹(로그인 페이지·관리자 헤더)에도 적용됐습니다.

**3단계 — 중요한 결정: AGPL 포크 (2026-07-24)**
다음 목표는 "터미널 밖에서도 광고를 보여줄 **오버레이 앱**"(화면에 항상 떠 있는 마스코트 + 광고 한 줄)입니다. 처음엔 처음부터 만들려 했는데(2달+ 예상), **clawd-on-desk 코드를 합법적으로 가져다 쓰기로 결정**했습니다.

- clawd-on-desk는 **AGPL-3.0** 라이선스: "코드 마음껏 가져가라. 대신 그걸로 만든 것도 똑같이 공개해라"라는 조건부 허락. 조건만 지키면 원작자 허락을 따로 받을 필요가 없습니다.
- 함정: AGPL 코드가 우리 **서버**에 섞이면 서버 소스(정산 로직 = 우리 핵심 자산)까지 공개 의무가 생깁니다.
- 해법: **레포를 둘로 분리**했습니다. 👇

## 3. 레포 두 개 — 구조와 절대 규칙

```
TJmedia/                        ← 두 레포는 반드시 형제 폴더로 나란히 clone
├── clawad/            (비공개 성격) 서버·정산·원장·CLI — 우리 핵심 자산
└── clawad-overlay/    (공개, AGPL) 오버레이 클라이언트 — clawd-on-desk 포크 예정
```

| | clawad | clawad-overlay |
|---|---|---|
| 내용 | 광고 서버, 4원장, 리워드, 운영자 콘솔, CLI | 데스크탑 펫 오버레이 (Electron) — 유일한 광고 표시 창구 |
| 라이선스 | 자체 (source-available) | **AGPL-3.0** |
| 상태 | 알파 마무리 중 | 뼈대만 (LICENSE·README·경계규칙·테마 검증기) |

**⚠️ 절대 규칙 (라이선스 경계):**
1. 두 레포는 **HTTP API로만** 대화합니다. 서로의 코드를 import/복사 금지.
2. AGPL 코드(clawd-on-desk에서 온 것)는 **clawad-overlay에만**. clawad에 한 줄도 넣지 않습니다.
3. clawd-on-desk의 **그림/아트는 라이선스와 무관하게 사용 금지**(원작자가 별도 권리 보유). 캐릭터는 우리 랍스터만 씁니다.
4. 상세 규칙: `clawad-overlay/docs/BOUNDARY.md`

## 4. 분업 — 우리 둘이 이렇게 나눕니다

| | 👤 A (김태정) — clawad 서버 | 👤 B (당신) — clawad-overlay 클라 |
|---|---|---|
| 당장 | P1 검토 중 5건 마무리 (CLAW-60·64·66·75·80) | **CLAW-89**: clawd-on-desk 포크 반입 + 맥에서 빌드 재현 |
| 다음 | CLAW-86 오버레이 범위 확정 문서, CLAW-87 프라이버시 | CLAW-90: 펫 아래 광고 렌더 + 노출 이벤트 서버 보고 |
| 후반 | CLAW-91 서버측, CLAW-96 | CLAW-91 클라측, CLAW-92 패키징, CLAW-93 멀티 OS QA |

- **일감 보드**: Jira `https://whatsuphouse.atlassian.net` CLAW 프로젝트, 에픽 CLAW-85(P3 오버레이)가 우리 트랙.
- **먼저 둘이 할 일 하나**: 오버레이↔clawad **로컬 파일 협약 확인**(30분). 계약 전문은 `docs/design/overlay-contract.md`에 있고, 네트워크는 CLI의 sync만 씁니다.
- **PR은 교차 리뷰**: A의 PR은 B가, B의 PR은 A가 승인. (지식 공유 + 라이선스 경계 감시)

## 5. 앞으로의 로드맵

1. P1 알파 완성 (A, 검토 5건) → 실사용자 알파 테스트
2. 오버레이 v1 (B 중심): 포크 → 광고 렌더 → Win+mac 패키징 → QA → **폐쇄 알파 배포** (코드서명은 알파에선 생략, 공개 배포 전 CLAW-95)
3. 법무 점검 CLAW-94 (AGPL 전략·상표) — 공개 배포 전 게이트
4. 수익 검증되면 P2 확장 (결제·셀프서브·타겟팅·현금 출금 등)

## 6. 맥북 환경 세팅 (B 기준, 30분)

### 6-1. 기본 도구

```bash
# Xcode Command Line Tools (git 포함)
xcode-select --install

# Homebrew (없다면)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js (팀은 v24 사용 중, LTS 22+ 이면 됨) + GitHub CLI
brew install node gh

# GitHub 로그인 (TJ-media 조직 레포 접근 계정으로)
gh auth login
```

### 6-2. 레포 클론 — 반드시 나란히!

```bash
mkdir -p ~/TJmedia && cd ~/TJmedia
gh repo clone TJ-media/clawad
gh repo clone TJ-media/clawad-overlay
```

> **왜 나란히?** clawad의 테마 빌더가 옆 폴더 `../clawad-overlay/tools/theme-spec/`의 검증기를 자동으로 찾아 씁니다. 없어도 빌드는 되지만 검증이 SKIPPED 됩니다.

### 6-3. clawad 동작 확인

```bash
cd ~/TJmedia/clawad
npm install
npm run lint && npm test          # 통과해야 정상
```

서버(NestJS)까지 돌려보려면 Docker Desktop(또는 OrbStack) 설치 후:

```bash
npm run infra:up                  # PostgreSQL 16 + Redis 7 컨테이너
cp apps/api/.env.example apps/api/.env   # 값 채우기는 아래 6-5 참고
npm run api:start
```

> B 담당(클라이언트)은 서버를 직접 띄울 일이 많지 않습니다. 광고 API가 필요하면 A의 개발 서버 주소를 받아 쓰는 것도 방법.

### 6-4. 마스코트 테마 빌드·확인

```bash
cd ~/TJmedia/clawad/mascot
node theme-build.js               # "schema validation: OK" 나오면 성공
open theme-preview.html           # 브라우저에서 7개 상태 애니메이션 미리보기
```

실제 앱에서 보려면: [clawd-on-desk 릴리스](https://github.com/rullerzhou-afk/clawd-on-desk/releases)에서 macOS 버전 설치 → 생성된 `theme-out/clawad/` 폴더를 테마 폴더에 복사 → 설정에서 "테마 새로고침".

- macOS 테마 폴더(일반적인 Electron 경로): `~/Library/Application Support/clawd-on-desk/themes/clawad`
- 테마를 수정했으면 캐시 폴더(`.../clawd-on-desk/theme-cache/clawad`)도 지워야 반영됩니다.
- 무서명 앱이라 첫 실행 시 Gatekeeper 경고 → 우클릭-열기로 통과.

### 6-5. 비밀값(.env) — 파일로 주고받지 마세요

`apps/api/.env`는 gitignore 되어 있고 DB 비밀번호·JWT 시크릿·Jira API 토큰 등이 들어갑니다. **A에게 1Password/신뢰 가능한 보안 채널로 요청**하세요. 채팅·이메일 평문 전송 금지.

### 6-6. Jira & 작업 습관

- Jira 계정 초대를 받아 `whatsuphouse.atlassian.net` CLAW 프로젝트에 들어오세요.
- Claude Code를 쓴다면: 세션 시작 때 프로젝트 루트의 `HANDOFF.md`(있으면)를 먼저 읽는 게 팀 규칙입니다. 프로젝트 규칙은 `.claude/CLAUDE.md`와 `.claude/rules/clawad.md`에 있습니다.

## 7. 규칙 요약 (어기면 리뷰에서 반려됩니다)

- **브랜치**: `develop`에서 분기 → `{feat|fix|chore|docs}/{이슈키 소문자}-{슬러그}` → **develop 대상 PR**. `main`은 운영 배포 때 `develop`에서만 머지합니다. 두 브랜치 모두 직접 푸시 금지 (`.claude/CLAUDE.md` §6).
- **커밋**: `feat|fix|chore: 한 줄 요약 (CLAW-이슈키)`. **AI 관련 문구(Co-Authored-By 등) 금지.**
- **하드코딩 금지**: 리워드 단가·상한 같은 정책 수치는 코드에 넣지 않습니다(서버 정책 설정으로만).
- **클라이언트는 사실만 보고**: 금액·잔액·부정 여부 판단은 전부 서버. 클라이언트에 비밀 키 없음.
- **프라이버시**: 클라이언트가 서버로 보내는 필드는 정해진 8개뿐. 새 필드 추가는 프라이버시 문서 갱신과 함께.
- **AGPL 경계**: §3의 절대 규칙 4개.

---

궁금한 건 Jira 이슈 코멘트나 A(김태정)에게. 환영합니다! 🦞
