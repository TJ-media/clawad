# 클로애드 (clawad)

광고주가 구매한 개발자 대상 광고 인벤토리를 Claude Code/IDE 사용자에게 제공하고, 검증된 광고 매출의 일부를 **비현금성 리워드**로 배분하는 광고 매체 플랫폼. 정책·설계는 [docs/](docs/README.md) 참조.

> **클린룸 고지**: 본 프로젝트는 kickbacks.ai의 소스코드를 참조하지 않고, 공개된 제품 설명(아이디어 차원)만을 바탕으로 독자 구현한다. 원본 레포 코드는 source-available(비오픈소스)이므로 열람·복제하지 않는다.

## 구조

```
clawad/
├── policy/               # 리워드·상한·간격 정책 설정 + 검증기 (단일 원본, 코드 하드코딩 금지)
├── client/
│   ├── statusline.js     # Claude Code statusLine 훅. 캐시 렌더링 + 사실 이벤트 기록 (핫패스, 네트워크 없음)
│   ├── sync.js           # 기기 등록 + serveToken 번들 프리페치 + 사실 이벤트 업로드
│   ├── machine.js        # 로컬 생성 가명 머신 ID (하드웨어 식별자 아님)
│   └── install.js        # 설치·제거(원상복구)·일시중지
├── apps/api/             # P1 서버 — NestJS + PostgreSQL + Redis (모듈형 모놀리스)
│   └── src/{auth,machines,campaigns,entities,migrations}
├── server/               # CLAW-2·3 참조 PoC (무의존성 node:http). lib/는 apps/api가 재사용
├── docs/                 # 정책·설계 문서 (CLAW-12~21)
├── test/                 # node:test (클라이언트·PoC)
└── data/                 # 런타임 생성: bundles.json, state.json, ledger.jsonl, machine.json (git 미포함)
```

## 동작 방식

1. `sync.js`가 기기를 등록(계정당 최대 3대)하고, 광고를 **표시하기 전에** `GET /v1/ad-decision`으로 서명된 `serveToken` 번들을 프리페치해 로컬 캐시(`bundles.json`)에 채운다. 머신당 미사용 토큰 수는 정책값으로 제한된다.
2. `statusline.js`는 **캐시만 읽는다**(네트워크 호출 없음). `[광고]` 표기와 함께 한 줄을 그리고, 같은 광고가 **5초 이상 연속 표시**되면 로컬 원장에 **사실만** 기록한다: `serveToken`·`sequence`·`machineId`·`startedAt`·`endedAt`·`clientVersion`.
3. 상태줄에는 정책 설정에서 읽은 율로 "예상 적립 P"를 표시한다(미검증 추정, 원화 미표시).
4. `sync.js`가 미전송 이벤트를 업로드한다. 서버 불통이면 로컬에 보관하고 다음에 재전송한다.
5. 서버가 토큰 서명·만료·viewability·동시노출·상한을 검증하고, **서버 정책값으로** 리워드·과금을 계산해 승인분만 반영한다.

**클라이언트는 금액·유효 노출 여부를 계산하지 않고, 멱등 키·HMAC을 만들지 않으며, 서비스 비밀 키를 갖지 않는다.** 멱등 키는 서버가 토큰 검증 후 생성한다: `SHA-256(jti:machineId:sequence)`.

## 설치 (Claude Code)

```bash
npm run clawad:install     # 변경 내용을 고지하고 기존 statusLine을 백업한 뒤 설정
npm run clawad:status      # 자동 sync·최근 성공·다음 실행·오류 상태 확인
npm run clawad:pause       # 광고 표시와 자동 sync 일시중지 / clawad:resume 으로 해제
npm run clawad:uninstall   # 백업에서 원상복구
```

`~/.claude/settings.json`의 `statusLine`을 설정하며, 기존 값이 있으면 백업해 제거 시 되돌린다. 설치 과정은 사용자 범위의 Windows 작업 스케줄러, macOS LaunchAgent, Linux systemd user timer에 자동 sync를 함께 등록한다. 로그인 후와 기본 5분 주기로 실행되며 `CLAWAD_SYNC_INTERVAL_MINUTES=10`처럼 1~1439분 사이로 바꿀 수 있다. 설치 시 `CLAWAD_SERVER`의 안전한 HTTP(S) origin도 예약 실행 설정에 보존하므로 주소나 주기를 바꾼 뒤에는 install을 다시 실행한다. 재설치는 기존 백업을 덮어쓰지 않고 작업을 갱신하며, uninstall은 클로애드가 소유한 작업 이름과 파일만 제거한다.

자동 sync는 로컬 PID 잠금으로 중복 실행을 건너뛴다. 살아 있는 PID의 잠금은 뺏지 않고, 종료된 PID는 즉시, 쓰다 만 손상 잠금은 15분 뒤 복구한다. refresh token 회전 결과와 원장 전송 상태는 같은 디렉터리의 임시 파일을 원자적으로 교체한다. 서버가 꺼져 있으면 원장과 광고 캐시를 그대로 보존하고 다음 주기에 재시도한다. 상태의 오류 코드는 네트워크 장애(`NETWORK_UNAVAILABLE`), 서버 세션 만료·폐기(`SESSION_EXPIRED`), 로컬 로그인 파일 누락·손상(`LOCAL_AUTH_MISSING`·`LOCAL_AUTH_INVALID`)을 구분하며 토큰이나 요청 URL을 출력하지 않는다.

## 실행 명령어

```bash
npm run lint       # 구문 검사
npm test           # 클라이언트·PoC 스모크 (node:test)
npm run typecheck  # 위 + apps/api 타입 검사

npm run infra:up   # PostgreSQL·Redis (호스트 55432·56379)
npm run api:start  # P1 API 서버 (NestJS)
npm run api:e2e    # API e2e (실제 DB·Redis 필요)
npm run infra:test-redis-persistence # 격리 볼륨에서 Redis 재시작 영속성 검증
npm run sync       # 기기 등록 + 번들 프리페치 + 이벤트 업로드

npm run server     # CLAW-2·3 참조 PoC 서버 (http://localhost:8787)
```

Redis는 AOF(`appendfsync=always`)와 `clawad-redisdata` 이름 볼륨을 사용한다. 따라서 `npm run infra:down` 후 다시 올려도 TTL이 남은 로그인 세션과 일회용 인증 상태가 유지된다. `docker compose down -v`는 PostgreSQL과 Redis 볼륨을 모두 삭제하는 **명시적 로컬 초기화**이므로 필요한 데이터가 없을 때만 실행한다. 기존 임시 Redis 볼륨에서 처음 전환하거나 백업·복구할 때는 [시크릿 관리·백업·복구 정책](docs/security/secrets-and-backup.md#redis-세션-영속화claw-45)을 따른다.

### P1 API (apps/api)

- `POST /v1/auth/social/:provider/start`·`GET …/callback`·`POST /v1/auth/social/exchange` — 소셜 전용 로그인(Google·Kakao·Naver, CLAW-37). `DELETE /v1/me/identities/:provider`로 연결 해제.
- `POST /v1/auth/refresh·logout` — 세션 토큰 회전·폐기 (CLAW-22). 사용자 이메일/비밀번호 signup·login은 비활성(관리자 로그인은 `POST /admin/v1/auth/login`).
- `POST /v1/machines` — 기기 등록(계정당 최대 3대, 초과 시 409) / `GET` 목록 / `DELETE /:machineId` 해제
- `GET /v1/ad-decision` — 광고 결정 + serveToken 발급 (인증·등록 기기 필요, 프리페치 상한 초과 시 429)
- `GET /v1/ad-decision/prefetch-status` — 미사용 토큰 수·상한·리필 필요 여부
- `DELETE /v1/ad-decision/prefetched-tokens` — 로컬 캐시 유실 시 미사용 토큰 멱등 폐기
- `POST /internal/v1/…` — 운영자 콘솔 내부 API: 광고주·캠페인·소재 심사·예산 (CLAW-23)

`POST /v1/events`(노출 검증 파이프라인)는 CLAW-6에서 구현한다.

## 로드맵

- [x] Phase 1 PoC: 상태줄(사실 이벤트) + 서버 권위 검증(serveToken·기기제한·동시노출 dedup·캠페인유형) + 정책 설정
- [ ] Phase 2: NestJS+PostgreSQL 이관, 광고주 셀프서브 포털, 회원/지갑, 포인트→상품권 교환
- [ ] Phase 3: VS Code 익스텐션(클릭 인벤토리), Codex·Cursor 어댑터, 타겟팅
