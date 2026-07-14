# 운영 배포·관측·백업·복구 절차

이 문서는 단일 호스트 Docker Compose 운영 기준이다. 실제 비밀값과 `.env`는 저장소가 아닌 비밀 관리자에서 주입하며 PostgreSQL·Redis·Prometheus·Alertmanager는 외부에 공개하지 않는다. Grafana는 호스트 loopback에만 bind하고 SSH 터널로 접근한다.

장애 등급, 긴급 중지와 복구 판단은 [알파 장애 대응 런북](incident-response.md)을 함께 따른다.

## 배포 전 필수값

`deploy/production/.env.example`을 호스트의 `deploy/production/.env`로 복사하고 권한을 `0600`으로 제한한다. 다음 값에는 버전명이나 branch가 아니라 실제 40자리 소문자 Git commit SHA를 넣는다.

- `RELEASE_SHA`: 배포할 checkout의 `git rev-parse HEAD`
- `ROLLBACK_SHA`: 현재 정상 동작 중이며 로컬에 보존한 직전 API 이미지의 commit SHA

배포·rollback 대상 이미지는 tag만 신뢰하지 않는다. 이미지 자체의
`org.opencontainers.image.revision=<commit>`과 `ai.clawad.emergency-stop-compatible=true`
label이 모두 일치해야 한다. 후자는 글로벌 광고·적립 중지와 과거 중지 구간 판정을 실제로
포함한 빌드에만 붙인다. 임의 retag나 label 덧씌우기로 호환성을 가장하지 않는다.

다음 파일은 비밀 관리자가 접근 제한된 호스트 경로에 한 줄로 배치한다. 경로만 `.env`에 넣고 내용은 저장소·shell 출력·티켓·CI 아티팩트에 남기지 않는다.

- `MONITORING_TOKEN_FILE`: API의 `/monitor/v1/metrics`와 Prometheus 사이에서만 쓰는 32바이트 이상 난수
- `ALERT_WEBHOOK_URL_FILE`: 운영 알림 수신기의 전체 HTTPS webhook URL
- `GRAFANA_ADMIN_PASSWORD_FILE`: Grafana 최초 관리자 비밀번호

네 개의 애플리케이션 서명 키도 각각 32바이트 이상의 서로 다른 난수로 만든다. DB·Redis·OAuth·관리자 자격 증명은 비밀 관리자에서 별도로 주입한다. `OBSERVABILITY_WINDOW_MINUTES`는 최근 노출·리워드 집계 창이며 알파 기본값은 15분이다.

구성 검사에서는 치환된 비밀을 출력하지 않는다.

```bash
npm run infra:prod:config
npm run infra:prod:observability-check
npm run infra:prod:observability-check -- --containers
```

마지막 명령은 고정된 Prometheus·Alertmanager 이미지의 `promtool`과 `amtool`까지 실행하고 핵심 알림 시계열 fixture도 검증하므로, 최초 실행 시 해당 이미지를 내려받을 수 있어야 한다.

## 최초 전환 배포

1. 운영 호스트에 Docker Engine과 Compose v2를 설치하고 DNS A/AAAA를 연결한다. 방화벽에는 80/443만 공개한다.
2. 위 `.env`와 세 secret 파일을 준비한다. `API_DOMAIN`, `ACME_EMAIL`, 명시적인 HTTPS `CORS_ORIGINS`와 `SOCIAL_RETURN_ALLOWLIST`도 설정한다.
3. CLAW-65 도입 전 API 이미지는 글로벌 긴급 중지를 이해하지 못하므로 rollback 대상으로 사용할 수 없다. 현재 운영 commit에 긴급 중지 gate만 먼저 backport한 별도 baseline commit을 검증·배포하고, Dockerfile이 생성한 두 image label을 확인한 뒤 그 commit을 `ROLLBACK_SHA`로 사용한다. 이 baseline 없이 최초 자동 배포를 시도하면 release 스크립트가 fail-closed로 거부한다.
4. 배포할 commit을 checkout하고 `npm run infra:prod:observability-check -- --containers`를 통과시킨다.
5. 아래 release 명령으로 백업, 이미지 build, 전체 서비스 기동, 공개 smoke test와 release 상태 기록을 한 번에 수행한다.

```bash
npm run infra:prod:deploy -- <RELEASE_SHA> <ROLLBACK_SHA> https://api.example.com
npm run infra:prod:release-status
```

release 명령은 checkout과 `RELEASE_SHA`가 다르거나 작업 트리에 미커밋 파일이 있으면 중단한다. 현재 컨테이너가 release label을 가진 이후에는 지정한 `ROLLBACK_SHA`가 실제 현재 배포와 달라도 중단한다. 또한 새 이미지, rollback 이미지와 자동복구 이미지의 실제 image ID에서 revision·긴급중지 호환 label을 매번 다시 검증한다. 성공 시 `BACKUP_DIR/release-state.json`과 접근 제한된 `.env`를 원자적으로 갱신한다. 실패하면 검증된 직전 이미지를 재build하지 않고 자동 rollback하고 공개 smoke test를 다시 수행한다.

API는 빈 DB에서 마이그레이션을 자동 적용한다. 마이그레이션은 전진 호환이어야 하며, 이전 애플리케이션이 새 스키마에서 동작하지 않는 변경은 이 절차로 배포하지 않는다.

소셜 로그인 운영 앱 공개와 외부 계정 검증은 [OAuth 운영 공개 런북](oauth-production.md)을 따른다.

## 관측 경계와 Grafana 접근

Prometheus는 backend 네트워크에서 `GET /monitor/v1/metrics`를 Bearer secret 파일로 수집한다. Caddy는 외부의 `/monitor`와 `/monitor/*`를 항상 404로 닫는다. 메트릭과 dashboard label에는 정해진 route family·상태·공급자·안전 오류 코드만 사용하며 토큰, 소셜 subject, 이메일, userId, machineId, URL·경로 파라미터, 프로젝트 경로와 프롬프트를 넣지 않는다.

Grafana는 기본 `127.0.0.1:3001`에만 열린다. 운영 호스트에 직접 public port를 추가하지 않고 SSH 터널을 사용한다.

```bash
ssh -L 3001:127.0.0.1:3001 <운영호스트>
```

로컬 브라우저에서 `http://127.0.0.1:3001`을 열고 `Clawad / Clawad 폐쇄 알파 운영` dashboard를 확인한다. 익명 접속과 회원가입은 꺼져 있다. Grafana·Prometheus·Alertmanager의 이름 volume은 일반 재기동에서 보존한다.

관측 구성은 다음 핵심 신호를 제공한다.

- API 상태, health·monitor probe를 제외한 사용자 API 5xx 비율과 p95 지연, 광고 결정 경로 전용 p95
- PostgreSQL·Redis 상태와 probe 지연
- 공급자별 OAuth start·callback·exchange 단계의 성공·취소·대기·안전 오류 코드
- 이벤트 승인·거절, 서버 수신 기준 업로드 지연, 광고 결정 404 기반 번들 부족 추정
- 노출 승인·거절 사유와 리워드 pending·confirm·claw_back 최근 창, 각 운영 집계 조회 성공 여부
- 식별자를 제외한 kill switch 대상별 활성 건수
- 현재 배포와 rollback commit SHA

서버는 네트워크에 도달하지 못한 로컬 sync 실패나 실제 로컬 번들 개수를 관찰할 수 없다. 광고 결정 404는 `NO_ELIGIBLE_AD` 외 기기 오류도 포함할 수 있으므로 번들 부족의 추정 신호로만 사용한다. 이 한계를 숨기거나 성공률로 오인하지 않는다.

## 재배포와 상태 확인

새 release마다 현재 정상 commit을 rollback 대상으로 지정한다.

```bash
npm run infra:prod:release-status
npm run infra:prod:deploy -- <새_RELEASE_SHA> <현재_RELEASE_SHA> https://api.example.com
npm run infra:prod:release-status
```

상태 명령은 다음 세 소스를 대조한다.

1. 실행 중 container의 실제 image ID에 구워진 OCI `org.opencontainers.image.revision` label
2. container에 설정된 `ai.clawad.rollback-revision` label
3. `.env`와 `BACKUP_DIR/release-state.json`

불일치하면 재기동하지 말고 배포 기록과 실제 이미지부터 확인한다. `docker inspect` 전체 출력에는 환경변수가 포함될 수 있으므로 운영 티켓에 붙이지 않는다. 상태 스크립트는 안전한 두 commit SHA만 출력한다.

명시적 rollback은 다음과 같이 수행한다.

```bash
npm run infra:prod:rollback -- https://api.example.com
npm run infra:prod:release-status
```

rollback은 현재 label에 기록된 정확한 이전 이미지를 재build 없이 기동하고 smoke test를 통과해야 완료된다. rollback smoke test가 실패하면 원 release를 다시 기동하고 검증하며, 그 복구까지 실패하면 수동 개입이 필요한 오류로 종료한다. 데이터 복구가 필요하면 별도의 점검 창에서 쓰기를 차단하고 검증된 백업을 새 DB에 복원한 뒤 원장 합계를 대조해 접속 대상을 전환한다.

## 최초 관리자 부트스트랩 종료

최초 한 번만 `ADMIN_BOOTSTRAP_ENABLED=true`와 임시 관리자 자격 증명을 주입해 기동한다. 실제 관리자 계정을 생성하고 로그인을 확인한 다음 `ADMIN_BOOTSTRAP_ENABLED=false`로 바꾸고 `ADMIN_BOOTSTRAP_PASSWORD`를 비밀 관리자에서도 삭제한 뒤 API를 재배포한다. 운영 검증기는 비활성화된 임시 비밀번호가 남아 있으면 기동을 거부한다.

## 백업과 격리 복구 드릴

배포 전과 매일 `npm run infra:prod:backup`을 실행한다. 결과는 `BACKUP_DIR`에 custom-format dump와 SHA-256 manifest로 생성된다. 백업은 호스트 밖의 암호화된 저장소로 복제하고 보존·접근 정책을 별도로 적용한다.

```bash
npm run infra:prod:backup
npm run infra:prod:restore-drill -- clawad-YYYYMMDDTHHMMSSZ.dump
```

복구 드릴은 dump 해시를 manifest와 비교한 뒤 tmpfs 격리 PostgreSQL에만 복원하고 광고 과금·리워드·노출·감사 원장의 구조와 합계를 검증한다. 운영 DB를 수정하지 않는다. 분기마다 최신 백업으로 드릴을 실행하고 성공 기록과 소요 시간을 접근 제한된 운영 기록에 남긴다.

Redis는 AOF `appendfsync=always`와 영속 volume을 사용한다. 호스트/클라우드 volume snapshot도 암호화해 보관한다. 재기동 후 세션 지속성은 별도 테스트로 확인하되 PostgreSQL 원장을 사실의 최종 원본으로 취급한다.

운영 데이터가 있는 환경에서 `docker compose down -v`를 실행하지 않는다. 일반 `down`과 재기동은 이름 volume을 보존하지만 장애 대응 중에는 서비스별 `stop`/`start`와 release 스크립트를 우선 사용한다.
