# AGENTS.md

이 문서는 Codex가 클로애드(clawad) 저장소에서 작업할 때 따르는 프로젝트 규칙의 단일 원본이다. 저장소 전체에 적용하며, 하위 디렉터리에 더 가까운 `AGENTS.md` 또는 `AGENTS.override.md`가 있으면 해당 범위에서는 그 지침이 우선한다. `.claude/**`는 Claude Code 전용 설정이므로 Codex 워크플로로 간주하지 않는다.

## 0. 서비스와 현재 범위

클로애드는 광고주가 구매한 개발자 대상 광고 인벤토리를 Claude Code/IDE 사용자에게 제공하고, 검증된 광고 매출의 일부를 **비현금성 리워드**로 배분하는 광고 매체 플랫폼이다. (원본 모델의 "수익 50% 배분"은 한국 비용 구조상 채택하지 않는다. 배분은 서버 정책값으로 관리한다 — CLAW-12.)

- 현재 PoC 런타임은 **Claude Code의 `statusLine` 훅**이다. Codex용 광고 어댑터는 아직 구현되지 않았다.
- Codex는 이 저장소의 개발·검토 에이전트로 사용한다. 제품 런타임 지원 여부와 혼동하지 않는다.
- kickbacks.ai의 proprietary/source-available 원본 코드와 비공개 자료는 열람·인용·복제하지 않는다.
- 공개된 제품 설명과 사용자가 제공한 요구사항만 참고해 클린룸으로 독자 구현한다.
- 경쟁사에서 파생한 명칭을 코드 식별자·API·UI·마케팅·브랜드에 사용하지 않는다. 경쟁사명은 클린룸 출처나 법적 고지에만 예외적으로 쓸 수 있다.

## 1. 기술 스택과 명령

- JavaScript, Node.js 24+, CommonJS
- 런타임 외부 의존성 없음. node 내장 모듈만 사용한다.
- 외부 패키지 추가는 사전에 사용자 승인을 받는다.
- 테스트는 `node:test`를 사용한다.

```bash
npm run lint      # 구문 검사
npm test          # 스모크 테스트
npm run server    # 광고 서버, 기본 http://localhost:8787
```

Windows PowerShell에서 `npm` 실행이 정책에 막히면 동일한 명령을 `npm.cmd`로 실행한다.

## 2. 프로젝트 구조

```text
client/statusline.js   # Claude Code statusLine 훅, 핫패스
client/sync.js         # 원장 업로드와 광고 인벤토리 갱신
server/index.js        # 광고 서빙·노출 수집·집계 API
server/ads.json        # 서버측 광고 인벤토리
ads.json               # 현재 PoC의 클라이언트 광고 캐시
test/                  # node:test 스모크 테스트
data/                  # 런타임 데이터, Git 제외
.codex/agents/         # 프로젝트 범위 Codex 커스텀 에이전트
.codex/hooks/          # 프로젝트 범위 Codex 훅
```

기존 구조는 관련 Jira 이슈와 사용자 승인 없이 재편하지 않는다.

## 3. CRITICAL 불변식

### 클라이언트 핫패스

- `client/statusline.js`에서는 네트워크 호출을 절대 하지 않는다.
- 동기 로컬 파일 I/O 몇 회 수준을 유지하고, 대용량 원장 스캔·무거운 연산을 추가하지 않는다.
- stdin이나 로컬 JSON이 비었거나 손상돼도 광고 또는 안전한 안내 문구를 **정확히 한 줄** 출력하고 exit 0 한다.

### 노출과 원장

- 같은 광고가 5초 이상 연속 표시된 경우에만 노출 1회를 기록한다. 기준 완화·우회는 금지한다.
- **멱등 키는 서버가 생성한다**: `SHA-256(tokenJti:machineId:sequence)`. serveToken에 `jti`를 담고, 클라이언트는 HMAC이나 비밀 키를 갖지 않는다. DB `UNIQUE(token_jti, machine_id, sequence)`로 중복 적립·과금을 막는다. 클라이언트 원장의 `slotKey`는 로컬 중복 append 방지용일 뿐 서버 멱등 키가 아니다.
- 같은 사용자 계정의 여러 기기 동시 노출은 **한 건만** 인정한다(`CONCURRENT_USER_IMPRESSION`). 제재가 아니라 중복 미인정이며, 나머지도 원장에는 남긴다. 동시성은 PostgreSQL 트랜잭션/잠금으로 보장한다.
- `ledger.jsonl`의 노출 레코드는 append-only다. 삭제하거나 기존 필드를 변경하지 않는다. 전송 상태는 `synced` 갱신으로만 관리한다.
- **클라이언트는 금액·리워드·유효 노출 여부를 결정·전송하지 않는다.** 사실만 보낸다(serveToken, sequence, machineId, startedAt, endedAt, userId, clientVersion). 서버가 정책값으로 계산한다. 클라이언트가 금액 필드를 실어보내도 서버는 무시한다.

### 가격·정책과 표시

- 리워드 단가·상한·간격, 광고주 CPM 등 모든 정책값은 서버 정책 설정(`policy/reward-policy.default.json`, 운영은 정책 테이블)에서만 관리한다. **코드에 숫자 하드코딩 금지.** 값 변경은 `policy/policy.js`의 불변식(일일 상한 ≤ 최대 적립, 최소 교환 도달일 ≤ 허용일)을 통과해야 한다.
- 캠페인 유형 **PAID/HOUSE/TEST**의 과금·리워드 자격을 강제한다. HOUSE·TEST는 광고주 매출·미지급 리워드 부채를 만들지 않는다.
- 계정당 활성 기기 최대 N대(정책값, 기본 3). 상한·빈도는 계정 단위. 다계정은 자동 차단하지 않고 위험 신호로만 다룬다. 하드웨어 식별자(MAC·시리얼·UUID)는 수집하지 않는다.
- 광고에는 반드시 `[광고]` 표기를 유지한다(하우스·테스트 광고 포함).
- 광고 문자열은 출력 전에 개행과 ANSI/OSC 등 터미널 제어문자를 제거하고 길이를 제한한다.

### 개인정보와 클린룸

- 프롬프트, 터미널 입력, 파일명, 프로젝트 경로, 소스 내용은 텔레메트리로 수집하지 않는다.
- 새 이벤트 필드는 수집 목적·보유 기간·서버 전송 여부가 정해진 뒤 추가한다.
- 경쟁사 원본 저장소를 조사하거나 비교 구현하지 않는다. 필요한 동작은 공개 제품 수준의 요구사항으로 다시 기술한다.

## 4. 견고성과 코드 스타일

- 모든 파일·stdin JSON은 파싱 전에 BOM(U+FEFF)을 제거한다.
- 파일 부재나 손상은 안전한 fallback으로 처리한다.
- 서버는 잘못된 입력에 4xx JSON으로 응답하고 크래시하지 않는다.
- 요청 본문·배치 크기·필드 타입과 범위를 검증한다.
- CommonJS(`require`)와 `'use strict'`를 유지한다.
- 함수·변수는 camelCase, 상수는 UPPER_SNAKE_CASE를 사용한다.
- 주석과 사용자 노출 문자열은 한국어를 우선한다.
- 사용자 변경과 무관한 포맷팅·리팩터링을 섞지 않는다.

## 5. 작업 절차

1. 시작 전에 `git status --short --branch`를 확인하고 사용자 변경을 보존한다.
2. 구현 작업은 연결된 Atlassian 도구로 관련 CLAW 이슈의 설명·상태·의존성을 읽는다. 이슈가 없으면 프로젝트 정책상 새 이슈가 필요한지 확인하고, 허용된 범위에서 생성한다.
3. `develop`에서 `feat/{이슈키 소문자}-{영문-슬러그}` 브랜치를 만든다. `main`과 `develop`에 직접 구현 커밋을 만들지 않는다.
4. 요구사항을 충족하는 최소 변경만 구현한다.
5. JavaScript를 수정하면 `npm run lint`와 `npm test`를 모두 실행한다. 문서·Codex 설정만 바꿔도 관련 형식 검증과 기존 테스트를 실행한다.
6. 실질적인 코드 변경은 가능하면 `build-validator`와 `clawad-reviewer`를 병렬로 사용해 검증한다.
7. 커밋·푸시·PR 생성과 Jira 상태 변경은 사용자가 해당 작업에서 요청했거나 승인한 범위에서만 수행한다.

## 6. Jira와 GitHub

- Jira 사이트: `https://whatsuphouse.atlassian.net`
- cloudId: `d4081ac1-010a-45f5-8241-d9d67209e21b`
- 프로젝트 키: `CLAW`
- 이슈 제목 접두사: `[CLIENT]`, `[SERVER]`, `[ADMIN]`, `[REWARD]`, `[SECURITY]`, `[PRIVACY]`, `[QA]`, `[INFRA]`, `[PRODUCT]`, `[LEGAL]`
- 에픽: CLAW-9(P0 정책·설계) → CLAW-10(P1 폐쇄 알파) → CLAW-11(P2 확장). 신규 이슈는 해당 에픽에 parent로 연결한다.
- Jira·GitHub의 비공개 정보와 쓰기 작업은 연결된 앱/도구를 우선 사용한다.
- 기능 브랜치는 `develop`으로 PR을 보낸다. `main`은 `develop`에서만 머지한다.

커밋 메시지:

```text
{feat|fix|chore}: {한 줄 요약} ({CLAW-이슈번호})
```

커밋 메시지와 PR에 AI 활용 문구나 `Co-Authored-By`를 추가하지 않는다.

## 7. 완료 조건

- Jira 요구사항과 이 문서의 불변식을 충족한다.
- 관련 lint·테스트·형식 검증이 통과한다.
- 보안·개인정보·정산 신뢰 경계를 약화하지 않는다.
- 사용자 변경이나 무관한 파일을 포함하지 않는다.
- 남은 위험, 미검증 항목, 후속 의사결정이 있으면 최종 보고에 명시한다.
