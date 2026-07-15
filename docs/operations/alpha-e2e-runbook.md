# 알파 E2E Go/No-Go 런북

이 문서는 CLAW-64의 Windows·macOS·Linux 및 Google·Kakao·Naver 알파 검증 절차와 판정 기준을 정의한다. 자동 테스트 통과만으로 알파 출시를 승인하지 않는다. 모든 필수 케이스에 실제 실행 증거가 있어야 하며 한 건이라도 `FAIL` 또는 `BLOCKED`이면 `NO-GO`다.

## 1. 안전 원칙

- 배포 대상 commit SHA를 고정하고 실행 중 변경하지 않는다.
- 캠페인 키는 `QA-ALPHA-` 접두사를 사용한다. 운영 캠페인을 테스트에 사용하지 않는다.
- 공급자별 별도 알파 QA 계정을 사용한다. 운영자·개발자 콘솔 구성원 계정은 소셜 로그인 증거로 인정하지 않는다.
- 증거에는 토큰, 쿠키, Authorization 헤더, OAuth code, client secret, 이메일 원문, 사용자 이름을 남기지 않는다. 계정은 `google-qa-01` 같은 불투명 별칭으로 기록한다.
- 테스트 중 생성된 append-only 노출·정산·동의 원장은 수정하거나 삭제하지 않는다. 정리는 캠페인 비활성화, 세션 폐기, 클라이언트 제거, 정책에 따른 QA 계정 삭제로 수행하고 보존 의무가 있는 원장은 QA 식별자로 격리한다.
- Redis/API 재시작은 승인된 점검 시간에 한 인스턴스씩 수행한다. 볼륨 삭제와 `docker compose down -v`는 금지한다.

## 2. 준비와 증거 저장소

- 각 OS의 깨끗한 일반 사용자 프로필과 지원 Node.js 24 이상
- Desktop/IDE에서 사용하는 셸과 Claude Code
- 배포된 API/Web HTTPS origin, 정확한 40자리 commit SHA
- 공급자별 QA 계정과 계정 연결·해제 후 복구 가능한 보조 계정
- `QA-ALPHA-YYYYMMDD-NN` 캠페인과 테스트 전 캠페인·계정·원장 건수 스냅샷
- 접근이 제한되고 보존 기간이 정해진 증거 저장소와 자격증명 없는 HTTPS 증거 인덱스 origin

결과 파일에는 증거 인덱스가 해석하는 고유한 `EVIDENCE:CLAW64/...` 참조만 적는다. 서로 다른 case가 증거 참조를 공유할 수 없다. 스크린샷과 서버 로그는 개인정보와 인증정보를 마스킹한 뒤 저장한다. Jira에는 제한 저장소 링크, 실행자, 시각, commit, 환경만 남긴다.

## 3. 자동 사전검증

checkout한 commit을 확인한 뒤 각 OS에서 실행한다.

```bash
npm run qa:alpha:preflight -- /restricted/CLAW-64-preflight-<os>.json
```

이 명령은 변경 사항이 없는 checkout의 HEAD SHA를 고정하고 lint, Node 테스트, TypeScript 검사, API 빌드, API E2E, Redis 재시작 후 지속성 검사를 실행한 뒤 인프라를 정리한다. 같은 Compose 프로젝트의 서비스가 이미 실행 중이면 기존 환경을 중단하지 않고 실패한다. 정리까지 완료되면 commit·platform·완료 시각이 담긴 권한 0600 manifest를 기록하고 `ALPHA_PREFLIGHT_PASS`를 출력한다. manifest를 OS별 고유 증거에 첨부한다. 실패하면 수동 E2E를 진행해도 판정은 `NO-GO`다.

## 4. 결과 템플릿

제한 저장소에 템플릿을 생성한다.

```bash
npm run qa:alpha:init -- /restricted/CLAW-64-result.json
```

`environment`의 placeholder를 실제 HTTPS origin, commit SHA, QA 캠페인 키, 시작 시각으로 바꾸고 OS별 `preflights`에 manifest의 commit·platform·완료 시각과 고유 증거 참조를 옮긴다. 세 manifest의 commit은 배포 commit과 정확히 같아야 한다. 각 case에는 `PASS`, `FAIL`, `BLOCKED`, 고유 증거 참조, 실행 시각, 관찰 메모를 기록한다. `FAIL`에는 번호가 있는 최소 재현 절차를 반드시 적는다.

## 5. OS 설치·업데이트·제거

Windows, macOS, Linux에서 각각 아래 순서를 실행한다.

1. 기존 설치가 없는 깨끗한 프로필에서 설치하고 statusLine 한 줄 출력과 동기화 작업 등록을 확인한다 (`OS.<os>.INSTALL`).
2. 사용자가 이미 설정한 statusLine을 준비하고 클로애드를 설치·업데이트한다. 기존 설정의 백업과 wrapper 연결, 재업데이트의 멱등성을 확인한다 (`OS.<os>.UPDATE`).
3. 공백과 한글이 포함된 홈/설정 경로에서 설치·실행한다 (`OS.<os>.SPACE_UNICODE_PATH`).
4. 로그인 셸과 Desktop/IDE에서 PATH가 다른 상태로 실행해 Node 및 클라이언트 탐색을 확인한다 (`OS.<os>.DESKTOP_IDE_PATH`).
5. 제거 후 기존 statusLine 설정이 정확히 복원되고 클로애드 스케줄·파일만 제거되는지 확인한다. 사용자 파일과 append-only 원장은 훼손하지 않는다 (`OS.<os>.UNINSTALL_RESTORE`).

각 단계는 설치 전후 설정의 비밀값을 제거한 diff, 정확한 버전, 한 줄 출력 캡처, 종료 코드를 증거로 남긴다.

## 6. OAuth 공급자 매트릭스

각 OS에서 Google, Kakao, Naver에 대해 신규 가입(`SIGNUP`), 로그아웃 뒤 재로그인(`RELOGIN`), 만료 전후 세션 갱신(`REFRESH`), 기존 세션 접근이 거부되는 로그아웃(`LOGOUT`), 두 번째 공급자 연결과 중복 계정 미생성(`LINK`), 마지막 로그인 수단 보호를 포함한 연결 해제(`UNLINK`)를 검증한다.

case ID는 `OAUTH.<os>.<google|kakao|naver>.<동작>`이다. callback URL에는 query string이 보이지 않게 캡처하고 네트워크 로그 원문은 첨부하지 않는다.

가입 또는 재로그인 직후 같은 계정과 QA 캠페인으로 아래 광고 전체 흐름도 OS×공급자 9개 조합마다 실행한다. 5초 노출부터 확정 리워드까지는 `E2E.<os>.<provider>.AD_VIEW_5S_SYNC_PENDING_CONFIRMED`, 안전한 클릭과 대시보드 집계는 `E2E.<os>.<provider>.SAFE_CLICK_DASHBOARD_CTR`에 기록한다. 한 조합의 증거를 다른 조합에 재사용할 수 없다.

## 7. 광고·리워드 전체 흐름

- 각 `E2E.<os>.<provider>.AD_VIEW_5S_SYNC_PENDING_CONFIRMED`: Claude 시작 후 실제 작업 활동을 만들고 같은 광고를 5초 이상 연속 표시한다. 로컬 append-only 원장 생성, sync, 서버 pending, 정책에 따른 confirmed 전환을 순서대로 확인한다. 요청 필드 목록으로 클라이언트가 금액이나 유효성을 결정·전송하지 않는 것도 확인한다.
- 각 `E2E.<os>.<provider>.SAFE_CLICK_DASHBOARD_CTR`: `[광고]` 표기와 안전한 click redirect를 확인하고 대시보드 노출·클릭·CTR이 동일 QA 캠페인 집계와 일치하는지 검산한다.
- `FLOW.MULTI_SESSION`: 같은 기기의 여러 Claude 세션에서 중복 slot append와 중복 적립이 없는지 확인한다.
- `FLOW.TWO_DEVICE`: 같은 계정의 두 기기에서 동시 노출을 만들고 한 건만 인정되며 나머지는 `CONCURRENT_USER_IMPRESSION`으로 원장에 남는지 확인한다.
- `FLOW.OFFLINE_RECOVERY`: 5초 노출 뒤 네트워크를 차단하고 원장이 보존되는지, 복구 후 한 번만 sync되는지 확인한다.
- `FLOW.REDIS_RESTART`: 처리 중 Redis 한 인스턴스를 재시작하고 지속성·재시도·멱등성을 확인한다.
- `FLOW.API_RESTART`: 처리 중 API 한 인스턴스를 재시작하고 클라이언트 재시도와 중복 과금·적립 부재를 확인한다.

대기 상태가 시간 기반 정책에 의존하면 정책값을 변경하지 말고 실제 전환까지 관찰한다. HOUSE/TEST 캠페인은 광고주 매출과 리워드 부채가 0인지 별도 검산한다.

## 8. QA 데이터 정리 게이트

1. `QA-ALPHA-` 캠페인을 비활성화하고 일반 사용자에게 더 이상 서빙되지 않는지 확인한다.
2. QA 계정의 모든 세션과 OAuth 연결을 정책에 맞게 폐기한다.
3. 세 OS에서 클라이언트를 제거하고 기존 statusLine 복원을 다시 확인한다.
4. 테스트 전후 캠페인·계정·노출·클릭·리워드 건수를 비교한다. QA 식별자가 없는 새 레코드가 없어야 한다.
5. 보존 대상 원장은 삭제하지 않고 QA 실행 ID로 추적 가능해야 한다. 삭제 가능한 임시 데이터만 승인된 관리 경로로 제거한다.

정리 결과가 불명확하거나 운영 데이터 오염이 한 건이라도 있으면 `FLOW.QA_DATA_CLEANUP`은 `FAIL`이다.

## 9. 보고서와 판정

```bash
npm run qa:alpha:report -- /restricted/CLAW-64-result.json /restricted/CLAW-64-report.md
```

`GO` 조건은 93개 필수 case 전부 `PASS`, QA 데이터 정리 `PASS`, 고정 commit과 배포 환경 일치, OS별 사전검증 증거 확인이다. 기본 명령은 `NO-GO`일 때 종료 코드 2를 반환한다. 미완성 보고서를 검토 목적으로 생성할 때만 `--allow-no-go`를 사용한다.

최종 보고서를 Jira CLAW-64에 연결하고 실패가 있으면 재현 절차, 영향 OS/공급자, 담당 후속 이슈를 함께 남긴다. 외부 장비나 계정이 없어 실행하지 못한 항목은 `PASS`로 추정하지 않고 `BLOCKED`로 유지한다.
