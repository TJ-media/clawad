# 폐쇄형 알파 장애 대응 런북

이 런북은 로그인·sync·광고·원장·리워드 장애를 빠르게 제한하면서 append-only 원장 정합성과 비밀·개인정보 경계를 지키기 위한 기준이다. 운영자가 확실하지 않은 경우 적립이나 데이터를 임의 수정하지 않고 광고·리워드 긴급 중지부터 검토한다.

## 장애 등급과 역할

| 등급 | 기준 | 최초 응답 목표 | 기본 조치 |
| --- | --- | --- | --- |
| SEV-1 | 원장 중복/불일치 가능성, 비밀 유출 의심, 전체 API·DB 장애, 잘못된 과금·적립 확산 | 즉시, 15분 이내 담당 지정 | incident commander 지정, 전체 광고·리워드 중지, 변경 동결, 사용자 공지 준비 |
| SEV-2 | 특정 OAuth 공급자 장애, 높은 sync 실패·업로드 지연, Redis 장애, 일부 기능 지속 실패 | 30분 | 영향 기능 격리, 해당 공급자 비활성화 또는 필요 시 전체 중지 |
| SEV-3 | 단일 사용자/머신/캠페인 장애, 우회 가능한 지연·경고 | 영업일 4시간 | 대상 kill switch 또는 정상 운영 절차로 처리 |

한 사람이 여러 역할을 맡을 수 있지만 다음 책임은 기록에서 구분한다.

- incident commander: 등급·중지·복구·종료 판단과 타임라인 승인
- operations responder: dashboard·상태 확인, 배포·rollback·서비스 복구 실행
- ledger reviewer: 노출·과금·리워드 aggregate snapshot 비교와 정합성 승인
- communications owner: 영향 범위가 확인된 문구만 사용자·내부 이해관계자에게 공지

## 절대 남기지 않는 정보

로그, dashboard, alert, Jira, 채팅과 사후 분석에는 다음 원문을 넣지 않는다.

- access/refresh/serve/click/admin/monitor token과 OAuth authorization code·client secret
- 소셜 subject, 이메일과 공급자 응답 본문
- 프롬프트, 터미널 입력, 프로젝트·파일 경로와 소스 내용
- raw URL path parameter나 query. 특히 클릭 URL의 token segment

증거에는 시간, release SHA, 고정 route family, HTTP 상태, 안전한 내부 오류 코드, aggregate count와 조치만 남긴다. `docker compose config`와 `docker inspect` 전체 출력은 비밀 환경변수를 포함할 수 있으므로 수집하지 않는다. 로그가 필요하면 제한된 시간 범위로 보고 sentinel·비밀 패턴 검사를 거친 요약만 첨부한다.

## 최초 10분 확인

1. Alertmanager 수신 시각, alert 이름, severity와 component를 기록한다.
2. 최근 배포와 rollback 대상을 확인한다.
3. 공개 API live/ready와 Docker 서비스 상태를 확인한다.
4. 원장 위험이 있으면 변경을 동결하고 배포 전 backup과 aggregate snapshot을 만든다.

```bash
npm run infra:prod:release-status
npm run infra:prod:smoke -- https://api.example.com https://app.example.com <현재_RELEASE_SHA>
docker compose -f deploy/production/compose.yml ps
npm run infra:prod:backup
npm run infra:prod:ledger-snapshot
```

Grafana의 `Clawad 폐쇄 알파 운영` dashboard에서 API 5xx/p95, PostgreSQL·Redis, OAuth 공급자, 이벤트 지연·거절, 광고 결정 404 추정치, 노출 사유, 리워드와 global kill switch를 확인한다. dashboard 값은 원시 사용자나 머신을 식별하는 조사 도구가 아니다.

## 신호별 대응

### API down·5xx·지연

1. `/health/live`와 `/health/ready`를 구분한다. live 실패는 프로세스·배포, ready만 실패하면 DB·Redis부터 본다.
2. release status가 배포 기록과 다르면 새 조작을 멈춘다.
3. 최근 release 직후 시작됐고 데이터 스키마가 전진 호환이면 `npm run infra:prod:rollback -- https://api.example.com https://app.example.com`을 실행한다. 스크립트가 긴급중지 호환 image label을 거부하면 구 이미지를 강제 기동하지 말고 API를 중지한 채 호환 baseline 또는 forward fix를 준비한다.
4. rollback 후 smoke와 alert resolved를 확인한다. 실패하면 SEV-1로 올리고 전체 중지를 유지한다.

### PostgreSQL

1. PostgreSQL container health와 저장 공간·호스트 상태를 확인한다. DB 자격 증명이나 접속 문자열을 출력하지 않는다.
2. 쓰기 결과가 불확실하면 광고·리워드를 전체 중지한다. append-only 원장을 수동 UPDATE/DELETE하지 않는다.
3. 재기동 후 aggregate snapshot을 장애 전 값과 비교한다. 복원이 필요하면 격리 restore drill을 먼저 통과한다.

### Redis

1. API ready와 Redis container health를 확인한다.
2. 임의 `FLUSHDB`, `KEYS`, AOF 본문 출력은 금지한다. 세션·일회용 state·토큰 registry의 원문을 증거로 수집하지 않는다.
3. AOF volume을 보존한 채 서비스만 복구한다. PostgreSQL 원장을 최종 사실로 사용하며, 복구 후 외부 계정 refresh와 sync를 검증한다.

### OAuth

1. provider별 start·callback·exchange 단계의 성공/실패 count와 안전 오류 코드만 확인한다.
2. 특정 공급자만 악화되면 `SOCIAL_{PROVIDER}_ENABLED=false`로 재배포하고 다른 공급자와 기존 세션은 유지한다.
3. client secret 변경은 [OAuth 운영 공개 런북](oauth-production.md)의 교체 순서를 따른다. 공급자 응답과 token을 복사하지 않는다.

### sync·광고 준비

서버는 오프라인 클라이언트의 실제 sync 실패와 로컬 bundle 수를 직접 볼 수 없다. 이벤트 업로드 지연과 거절률, 광고 결정 성공/404를 함께 보되 404를 곧바로 재고 부족으로 확정하지 않는다. client의 `sync-state.json`은 사용자가 직접 확인하되 프로젝트 경로나 token이 없는 안전 오류 코드와 시각만 전달받는다.

### 리워드

pending 장기화나 claw_back 급증은 자동 잔액 수정으로 해결하지 않는다. 적립 batch를 멈추고 원장 aggregate와 관련 노출 판정을 검토한다. 긴급 중지 중에도 claw_back은 부정 확산을 막기 위해 허용되지만 SUPERADMIN 감사 기록과 incident reference가 필요하다.

## 전체 광고·리워드 긴급 중지

SEV-1 incident commander 승인 후 SUPERADMIN 단기 JWT로 실행한다. JWT를 command history나 문서에 직접 붙이지 않고 현재 shell의 일시 변수로만 사용한 뒤 즉시 해제한다.

```bash
curl --fail-with-body -X POST https://api.example.com/internal/v1/emergency-stop \
  -H "Authorization: Bearer ${ADMIN_JWT}" \
  -H 'Content-Type: application/json' \
  --data '{"reasonCode":"ALPHA_INCIDENT","incidentRef":"CLAW-65"}'

curl --fail-with-body https://api.example.com/internal/v1/kill-switches \
  -H "Authorization: Bearer ${ADMIN_JWT}"
```

응답과 조회에서 `GLOBAL_ADS`와 `GLOBAL_REWARDS`가 모두 활성인지 확인한다. 이 조작은 하나의 PostgreSQL transaction과 감사로그로 처리된다.

- 새 광고 결정은 `404 NO_ELIGIBLE_AD`, 기존 click은 `409 CLICK_DISABLED`가 된다.
- 이미 발급된 serveToken의 업로드는 200 응답 안에서 `REJECTED/KILLED`로 append되며 CAPTURE·리워드를 만들지 않는다.
- pending·confirm batch는 `paused=true`, 0행으로 끝난다. 기존 원장 행은 수정하거나 삭제하지 않는다.
- sync는 서버 중지를 확인하면 로컬 bundle cache만 원자적으로 비운다. 로컬 ledger는 보존한다.
- 오프라인 클라이언트 화면은 다음 sync 전까지 즉시 멈춘다고 보장할 수 없다. 서버 인정·과금·적립은 즉시 중지된다.

개별 대상은 `POST /internal/v1/kill-switch`에 `MACHINE|USER|CAMPAIGN|GLOBAL_ADS|GLOBAL_REWARDS`, `targetId`, `reasonCode`, `incidentRef`를 보낸다. global target의 `targetId`는 정확히 `GLOBAL`이다. 개별 해제는 동일한 안전 사유 body로 `DELETE /internal/v1/kill-switch`를 사용한다.

사용자·머신 중지는 다음 성공 sync에서 해당 클라이언트의 광고 cache 전체를 비우고, 캠페인 중지는 `prefetch-status`의 안전한 UUID 목록으로 해당 캠페인 bundle만 원자 제거한다. 오프라인 클라이언트 화면을 즉시 원격 삭제할 수는 없지만, 서버의 신규 발급·클릭·노출 인정·과금·적립 차단은 중지 응답을 기준으로 유지된다.

## 정합성 확인과 전체 재개

재개 전 다음을 모두 만족해야 한다.

1. 원인이 제거되고 API·DB·Redis 핵심 alert가 resolved다.
2. 중지 중 테스트 이벤트는 impression 원장에 `KILLED`로 append됐고 billing/reward count와 잔액은 증가하지 않았다.
3. rollback 또는 수정 release의 commit SHA와 smoke 결과가 기록됐다.
4. ledger reviewer와 incident commander가 재개를 승인했다.

```bash
curl --fail-with-body -X POST https://api.example.com/internal/v1/emergency-resume \
  -H "Authorization: Bearer ${ADMIN_JWT}" \
  -H 'Content-Type: application/json' \
  --data '{"reasonCode":"INCIDENT_RESOLVED","incidentRef":"CLAW-65"}'

curl --fail-with-body https://api.example.com/internal/v1/kill-switches \
  -H "Authorization: Bearer ${ADMIN_JWT}"
unset ADMIN_JWT
```

두 global active 행이 없어졌는지 확인하고 dedicated QA 계정·캠페인으로 새 광고 결정, 5초 표시, sync, pending과 confirm을 순서대로 검증한다. 중지 중 backlog는 재개 후 정책과 원장에 따라 처리한다.

## QA 장애 주입 드릴

실운영에서는 실행하지 않는다. 별도 QA/staging domain과 전용 alert receiver가 있는 Compose host에서만 실행한다. 스크립트는 `API_DOMAIN`에 `qa`, `staging` 또는 `test` 경계가 없으면 거부하고 `down -v`나 volume 삭제를 사용하지 않는다.

```bash
CLAWAD_DRILL_ENV=qa npm run infra:prod:observability-drill -- --confirm CLAW-65
```

드릴은 API, Redis, PostgreSQL을 하나씩 `stop`하고 다음을 확인한 뒤 매 단계 복구한다.

- `ClawadApiDown` firing → API 복구 → resolved
- `ClawadDependencyDown` firing → Redis 복구 → resolved
- `ClawadDependencyDown` firing → PostgreSQL 복구 → resolved

예외·SIGINT·SIGTERM에서도 세 서비스를 다시 기동하고 ready를 기다린다. Alertmanager의 firing/resolved 확인과 별개로 외부 receiver가 두 상태를 실제 수신했는지는 운영자가 receiver 기록에서 확인해 incident evidence에 남긴다. OAuth 오류와 global stop 정합성은 API e2e 및 dedicated QA 계정 시나리오로 별도 검증한다.

## 사용자 공지

communications owner는 영향이 확인되기 전 추측 원인이나 개인 단위 정보를 공지하지 않는다.

- 최초 공지: 시작 시각, 영향 기능, 광고·적립 중지 여부, 다음 갱신 예정 시각
- 진행 공지: 확인된 범위와 안전한 임시 조치. 예상 복구 시각이 불확실하면 그대로 명시
- 종료 공지: 복구 시각, 사용자 조치 필요 여부, 누락 리워드 검증·보정 방식과 문의 경로

비밀 유출 또는 개인정보 침해 가능성이 있으면 일반 장애 공지와 별개로 보안·법률 보고 절차를 즉시 시작한다.

## 종료와 사후 분석

모든 alert가 정상화됐다는 이유만으로 incident를 종료하지 않는다. smoke, release status, 원장 aggregate, QA 전체 흐름과 사용자 영향 확인 후 incident commander가 종료한다. 2영업일 안에 다음 형식으로 사후 분석을 남긴다.

```text
사건 번호 / 등급:
시작·탐지·완화·복구·종료 시각(KST/UTC 병기):
영향 범위와 사용자 공지:
탐지 신호와 늦어진 이유:
직접 원인 / 기여 요인:
광고·적립 중지 및 원장 정합성 증거(aggregate만):
배포·rollback commit SHA:
잘 작동한 통제 / 실패한 통제:
재발 방지 조치, 담당 역할, 기한, Jira:
금지정보 미포함 검토자:
```

사후 분석에는 raw 로그나 요청 본문 대신 재현 절차와 안전한 aggregate를 사용한다.
