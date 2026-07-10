# CLAUDE.md

이 문서는 Claude Code가 클로애드(clawad) 프로젝트에서 작업할 때 따라야 할 규칙을 정의한다.

---

## 0. 서비스 소개

클로애드(clawad)는 AI 코딩 에이전트(Claude Code)의 대기 시간에 상태줄 광고를 노출하고, 광고 수익의 50%를 개발자에게 돌려주는 서비스.
- kickbacks.ai의 **클린룸 독자 구현** — 원본 소스코드 열람·복제 절대 금지 (source-available 비오픈소스)
- 공개된 제품 설명(광고 위치, 과금 단위, 수익 배분 아이디어)만 참고한다

---

## 1. 기술 스택

- **언어**: JavaScript (Node.js 24+, CommonJS)
- **의존성**: 없음 — node 내장 모듈만 사용한다 (`node:http`, `fs`, `path`). 외부 패키지 추가는 사용자 승인 필요.
- **테스트**: node:test (`npm test`)

---

## 2. 실행 명령어

```bash
npm run lint      # 구문 검사 (node --check)
npm test          # 스모크 테스트
npm run server    # 광고 서버 (http://localhost:8787)
```

---

## 3. 프로젝트 구조

```
client/statusline.js   # Claude Code statusLine 훅 (핫패스)
client/sync.js         # 원장 업로드 + 인벤토리 갱신
server/index.js        # 광고 서빙/노출 수집/집계 API
server/ads.json        # 서버측 광고 인벤토리
test/                  # node:test 스모크
ads.json               # 클라이언트 로컬 광고 캐시
data/                  # 런타임 데이터 (git 미포함)
```

---

## 4. 아키텍처 핵심 규칙

상세 규칙은 `.claude/rules/clawad.md`를 따른다. 요약:

- **핫패스 무네트워크**: `statusline.js`는 상태줄 갱신마다 호출된다. 네트워크 호출·무거운 연산 금지. 로컬 파일만.
- **멱등 키**: 노출(impression)은 `광고ID:슬롯시각` 키로 기록하고, 서버는 키 기준으로 중복을 버린다.
- **원장은 append-only**: `ledger.jsonl`은 추가만 한다. 수정이 필요하면 sync의 synced 플래그만 갱신.
- **BOM 방어**: Windows 도구가 파일/stdin에 BOM을 붙일 수 있다. 모든 JSON 파싱 전 BOM을 제거한다.
- **viewability**: 같은 광고가 5초 이상 연속 표시돼야 노출 1회. 이 기준을 우회하는 코드 금지.

---

## 5. Jira 연동

- 사이트: `https://whatsuphouse.atlassian.net` (cloudId: `d4081ac1-010a-45f5-8241-d9d67209e21b`)
- 프로젝트 키: `CLAW` (클로애드)
- 일감 등록: `/create-jira`, 자동 개발: `/auto-dev {이슈키}`, 추천: `/jira-next`
- 이슈 제목 접두사: `[CLIENT]` / `[SERVER]` / `[INFRA]`

---

## 6. 작업 시 주의사항

- 기존 패키지 구조를 임의로 변경하지 않는다.
- 변경은 최소 단위로 수행한다.
- 기존 코드 스타일을 우선적으로 따른다.
- 단가·배분율(CPM 1,000원, 개발자 50%) 변경은 사용자 승인 필요.

---

## 7. Git 브랜치 전략

- `main` — 운영 브랜치. develop에서만 머지.
- `develop` — 개발 브랜치. 기능 브랜치의 머지 대상.
- `feat/{이슈키 소문자}-{영문-슬러그}` — 기능 브랜치. develop에서 분기하고 develop으로 머지.

흐름: `feat/*` → `develop` → `main`

## 8. Git 커밋 규칙

- 커밋 메시지: `{feat|fix|chore}: {한 줄 요약} ({이슈키})`
- 커밋 메시지에 AI 활용 관련 내용을 포함하지 않는다. (Co-Authored-By 등 금지)
