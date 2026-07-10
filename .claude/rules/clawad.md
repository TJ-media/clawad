# Clawad Rules

이 문서는 클로애드 코드 작성 규칙을 정의한다.
우선순위: **[CRITICAL]** 위반 시 머지 불가 / **[HIGH]** 리뷰에서 반드시 지적 / **[MEDIUM]** 가능하면 수정

---

## 1. 클린룸 원칙 [CRITICAL]

- kickbacks.ai 원본 레포 코드를 열람·인용·복제하지 않는다. 공개 제품 설명(아이디어)만 참고한다.
- "kickback" 계열 네이밍을 코드·문서·브랜드 어디에도 쓰지 않는다.

## 2. 핫패스 규칙 (client/statusline.js) [CRITICAL]

- 네트워크 호출 금지. 로컬 파일 I/O만 허용한다.
- 실행 시간에 민감하다 — 동기 파일 읽기 몇 회 수준을 유지하고, 무거운 연산·대용량 스캔을 추가하지 않는다.
- stdin이 비어 있거나 깨진 JSON이어도 반드시 광고 한 줄을 출력하고 exit 0 한다. (상태줄이 깨지면 안 됨)
- 출력은 정확히 한 줄. ANSI 색상 허용.

## 3. 집계 무결성 [CRITICAL]

- 노출은 viewability 기준(같은 광고 5초 이상 연속 표시)을 만족할 때만 기록한다. 기준 완화·우회 금지.
- 노출 기록은 멱등 키(`광고ID:슬롯시각`)를 포함한다. 서버는 키 중복을 조용히 버린다.
- `ledger.jsonl`은 append-only. 항목 삭제·수정 금지 (sync의 synced 플래그 갱신만 예외).
- 단가(CPM 1,000원)·배분율(50%) 상수 변경은 사용자 승인 필요.

## 4. 의존성 규칙 [HIGH]

- 외부 npm 패키지를 추가하지 않는다. node 내장 모듈만 사용한다.
- 정말 필요하면 사용자 승인을 받고 package.json에 사유를 주석 대신 커밋 메시지로 남긴다.

## 5. 견고성 [HIGH]

- 모든 JSON 파싱 전에 BOM(U+FEFF)을 제거한다. (Windows 도구 호환)
- 파일이 없거나 깨져 있어도 크래시하지 않고 fallback으로 동작한다.
- 서버 API는 잘못된 입력에 4xx JSON으로 응답한다. 크래시 금지.

## 6. 스타일 [MEDIUM]

- CommonJS(`require`) 유지. 'use strict' 선언.
- 함수·변수는 camelCase, 상수는 UPPER_SNAKE_CASE.
- 주석과 사용자 노출 문자열은 한국어.
- 광고 문구에는 반드시 `[AD]` 표기가 붙는다 (표시광고법). 표기 제거 금지.

## 7. 금지 사항 요약

- [CRITICAL] statusline.js에서 네트워크 호출
- [CRITICAL] viewability/멱등 키 우회
- [CRITICAL] 원본(kickbacks.ai) 코드 참조
- [HIGH] 외부 npm 의존성 추가
- [HIGH] BOM 미처리 JSON 파싱
- [MEDIUM] `[AD]` 표기 변경·제거
