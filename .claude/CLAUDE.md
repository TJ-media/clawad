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
- **클라이언트**: Node.js 내장 모듈만 (statusline 핫패스 + sync 데몬)
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
- **serveToken 검증**: 노출 인정은 서버 검증 통과분만. serveToken에 jti. **멱등 키는 서버 생성** = SHA-256(tokenJti:machineId:sequence), DB UNIQUE(token_jti, machine_id, sequence).
- **계정·기기·동시노출**: 계정당 기기 최대 3대(정책값), 4대째 409. 상한은 계정 단위. 같은 계정 여러 기기 동시 노출은 한 건만 인정(CONCURRENT_USER_IMPRESSION, 제재 아님). 다계정은 위험 신호(MULTI_ACCOUNT_RISK)일 뿐 자동 차단 금지.
- **캠페인 유형**: PAID/HOUSE/TEST 과금·리워드 자격 강제. HOUSE·TEST는 매출·부채 미발생.
- **4원장 분리·append-only**: 잔액은 원장 합산으로만. balance 직접 수정 금지.
- **핫패스 무네트워크**: statusline은 로컬 캐시만. `[광고]` 표기 필수.
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

## 6. Git 브랜치 전략

- `main` — 운영. develop에서만 머지 / `develop` — 개발. 기능 브랜치의 머지 대상
- `feat/{이슈키 소문자}-{영문-슬러그}` — develop에서 분기, develop으로 머지

## 7. Git 커밋 규칙

- 커밋 메시지: `{feat|fix|chore}: {한 줄 요약} ({이슈키})`
- 커밋 메시지에 AI 활용 관련 내용을 포함하지 않는다. (Co-Authored-By 등 금지)
