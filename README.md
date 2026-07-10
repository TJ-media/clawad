# 클로애드 (clawad)

광고주가 구매한 개발자 대상 광고 인벤토리를 Claude Code/IDE 사용자에게 제공하고, 검증된 광고 매출의 일부를 **비현금성 리워드**로 배분하는 광고 매체 플랫폼. 정책·설계는 [docs/](docs/README.md) 참조.

> **클린룸 고지**: 본 프로젝트는 kickbacks.ai의 소스코드를 참조하지 않고, 공개된 제품 설명(아이디어 차원)만을 바탕으로 독자 구현한다. 원본 레포 코드는 source-available(비오픈소스)이므로 열람·복제하지 않는다.

## 구조

```
clawad/
├── policy/               # 리워드·상한·간격 정책 설정 + 검증기 (단일 원본, 코드 하드코딩 금지)
├── client/
│   ├── statusline.js     # Claude Code statusLine 훅. 광고 렌더링 + 사실 이벤트 기록 (핫패스, 네트워크 없음)
│   └── sync.js           # 기기 등록 + 사실 이벤트 업로드 + 인벤토리 갱신
├── server/
│   ├── index.js          # 광고 결정·기기 등록·노출 검증·집계 API (의존성 없는 node:http)
│   └── lib/               # 멱등키·serveToken·동시노출 dedup·기기제한·캠페인유형 순수 모듈
├── docs/                 # 정책·설계 문서 (CLAW-12~21)
├── test/                 # node:test
└── data/                 # 런타임 생성: state.json, ledger.jsonl, machine.json (git 미포함)
```

## 동작 방식

1. `statusline.js`가 로컬 캐시 광고를 15초 주기로 로테이션하고, **5초 이상 연속 표시** 시 노출을 로컬 원장에 **사실만**(machineId·sequence·startedAt·endedAt) 기록. 금액은 넣지 않는다.
2. 상태줄에는 정책 설정에서 읽은 율로 "예상 적립 P"를 표시(미검증 추정). `[광고]` 표기.
3. `sync.js`가 기기를 등록(계정당 최대 3대)하고 `serveToken`을 받아 사실 이벤트를 업로드.
4. 서버가 토큰·viewability·동시노출·상한을 검증하고, **서버 정책값으로** 리워드·과금을 계산해 승인분만 반영. 멱등 키는 서버가 생성한다(`SHA-256(jti:machineId:sequence)`).

## 설치 (Claude Code)

`~/.claude/settings.json`에 추가:

```json
"statusLine": {
  "type": "command",
  "command": "node C:/Users/SSAFY/Desktop/TJmedia/clawad/client/statusline.js"
}
```

## 실행 명령어

```bash
npm run lint     # 구문 검사 (node --check)
npm test         # 스모크 테스트 (node:test)
npm run server   # 광고 서버 기동 (http://localhost:8787)
```

- `GET /v1/ads` — 광고 인벤토리
- `GET /v1/ad-decision?machineId=…` — 광고 결정 + serveToken 발급
- `POST /v1/machines` — 기기 등록(계정당 최대 3대, 초과 시 409 MACHINE_LIMIT_EXCEEDED) / `POST /v1/machines/release` — 해제
- `POST /v1/events` — 사실 이벤트 업로드(서버가 검증·계산, 금액 필드는 무시)
- `GET /v1/stats` — 캠페인 유형(PAID/HOUSE/TEST)별 유효 노출·리워드·거절 사유 집계

## 로드맵

- [x] Phase 1 PoC: 상태줄(사실 이벤트) + 서버 권위 검증(serveToken·기기제한·동시노출 dedup·캠페인유형) + 정책 설정
- [ ] Phase 2: NestJS+PostgreSQL 이관, 광고주 셀프서브 포털, 회원/지갑, 포인트→상품권 교환
- [ ] Phase 3: VS Code 익스텐션(클릭 인벤토리), Codex·Cursor 어댑터, 타겟팅
