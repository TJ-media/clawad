# 클로애드 (clawad)

AI 코딩 에이전트(Claude Code)의 대기 시간에 상태줄 광고를 노출하고, 광고 수익의 50%를 개발자에게 돌려주는 서비스.

> **클린룸 고지**: 본 프로젝트는 kickbacks.ai의 소스코드를 참조하지 않고, 공개된 제품 설명(광고 위치·과금 단위·수익 배분이라는 아이디어 차원)만을 바탕으로 독자 구현한다. 원본 레포 코드는 source-available(비오픈소스)이므로 열람·복제하지 않는다.

## 구조

```
clawad/
├── client/
│   ├── statusline.js   # Claude Code statusLine 훅. 광고 렌더링 + 노출 집계 (핫패스, 네트워크 없음)
│   └── sync.js         # 로컬 원장(ledger)을 서버로 업로드
├── server/
│   ├── index.js        # 광고 서빙 + 노출 수집 API (의존성 없는 node:http)
│   └── ads.json        # 서버측 광고 인벤토리
├── test/               # node:test 스모크 테스트
├── ads.json            # 클라이언트 로컬 광고 캐시 (sync가 갱신)
└── data/               # 런타임 생성: state.json, ledger.jsonl (git 미포함)
```

## 동작 방식

1. Claude Code가 상태줄을 그릴 때마다 `statusline.js`를 호출 (stdin으로 세션 JSON 전달)
2. 로컬 `ads.json`에서 광고를 로테이션 (15초 주기)
3. 동일 광고가 **5초 이상 연속 표시**되면 노출(impression) 1회로 원장에 기록 — viewability 기준
4. 노출당 총 단가 1원(CPM 1,000원), 개발자 몫 50% = 0.5원. 상태줄에 오늘/누적 수익 실시간 표시
5. `sync.js`가 미전송 원장 항목을 멱등 키와 함께 서버로 업로드

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

- `GET /ads` — 현재 광고 인벤토리
- `POST /impressions` — 노출 배치 업로드 (key 기준 멱등)
- `GET /stats` — 광고별 노출/비용 집계

## 로드맵

- [x] Phase 1 PoC: 터미널 상태줄 + 로컬 원장 + 목 서버
- [ ] Phase 2: 광고주 셀프서브 포털, 고정 CPM 예약, 회원/지갑, 포인트→상품권 교환
- [ ] Phase 3: VS Code 익스텐션(클릭 인벤토리), 경매, 어뷰징 탐지(일일 상한·머신 지문)
