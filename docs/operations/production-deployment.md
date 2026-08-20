# 운영 배포·관측·백업·복구 절차

알파 출시 전 OS·OAuth·광고 전체 흐름 판정은 [알파 E2E Go/No-Go 런북](./alpha-e2e-runbook.md)을 따른다.

이 문서는 단일 호스트 Docker Compose 운영 기준이다. 실제 비밀값과 `.env`는 저장소가 아닌 비밀 관리자에서 주입하며 PostgreSQL·Redis·Prometheus·Alertmanager는 외부에 공개하지 않는다. Grafana는 호스트 loopback에만 bind하고 SSH 터널로 접근한다.

장애 등급, 긴급 중지와 복구 판단은 [알파 장애 대응 런북](incident-response.md)을 함께 따른다.

## 배포 전 필수값

`deploy/production/.env.example`을 호스트의 `deploy/production/.env`로 복사하고 권한을 `0600`으로 제한한다. 다음 값에는 버전명이나 branch가 아니라 실제 40자리 소문자 Git commit SHA를 넣는다.

- `RELEASE_SHA`: 배포할 checkout의 `git rev-parse HEAD`
- `ROLLBACK_SHA`: 현재 정상 동작 중이며 로컬에 보존한 직전 API·user-web 이미지의 commit SHA

배포·rollback 대상 이미지는 tag만 신뢰하지 않는다. 이미지 자체의
`org.opencontainers.image.revision=<commit>`과 `ai.clawad.emergency-stop-compatible=true`
label이 모두 일치해야 한다. 후자는 글로벌 광고·적립 중지와 과거 중지 구간 판정을 실제로
포함한 빌드에만 붙인다. 임의 retag나 label 덧씌우기로 호환성을 가장하지 않는다.

다음 파일은 비밀 관리자가 접근 제한된 호스트 경로에 한 줄로 배치한다. 경로만 `.env`에 넣고 내용은 저장소·shell 출력·티켓·CI 아티팩트에 남기지 않는다.

경로는 **영속 디스크**여야 한다(`.env.example` 기본값 `/var/lib/clawad-secrets`, 디렉터리 `0700`). tmpfs(`/run`)에 두면 무인 재부팅으로 파일이 사라지고, compose 시크릿 마운트가 실패해 `api`·`prometheus`·`grafana`·`alert-bridge`가 연쇄로 뜨지 않는다. 그러면 장애를 알릴 주체까지 함께 사라진다 (CLAW-179, CLAW-152와 같은 클래스).

- `MONITORING_TOKEN_FILE`: API의 `/monitor/v1/metrics`와 Prometheus 사이에서만 쓰는 32바이트 이상 난수
- `ALERT_WEBHOOK_URL_FILE`: 운영 알림 수신기(Mattermost 수신 웹훅)의 전체 HTTPS URL. 이 파일은 **alertmanager가 아니라 `alert-bridge`가** 시크릿으로 읽는다.
- `GRAFANA_ADMIN_PASSWORD_FILE`: Grafana 최초 관리자 비밀번호

`LEGAL_PUBLIC_DIR`에는 법무 검토가 끝난 약관·개인정보처리방침·개인정보 문의·제거 안내 공개본만 둔다. 이 디렉터리는 배포가 `docs/legal/public/`의 `*.html`·`_style.css`로 동기화하므로 손으로 채우는 것은 최초 부트스트랩뿐이다 (CLAW-225). 저장소의 `docs/legal` 상위 문서는 외부 공개 금지 초안이므로 복사하지 않는다. `.env`의 네 `LEGAL_*_URL`은 이 디렉터리의 서로 구분된 파일을 가리켜야 하며, 공개 금지·미확정 마커가 남아 있으면 배포 smoke가 실패한다.

네 개의 애플리케이션 서명 키도 각각 32바이트 이상의 서로 다른 난수로 만든다. DB·Redis·OAuth·관리자 자격 증명은 비밀 관리자에서 별도로 주입한다. `OBSERVABILITY_WINDOW_MINUTES`는 최근 노출·리워드 집계 창이며 알파 기본값은 15분이다.

구성 검사에서는 치환된 비밀을 출력하지 않는다.

```bash
npm run policy:check
npm run infra:prod:config
npm run infra:prod:observability-check
npm run infra:prod:observability-check -- --containers
```

`policy:check`는 정책 파일이 로드 가능하고 불변식을 통과하는지 확인한다. API는 기동 시 같은 검사를 하고 실패하면 종료 코드 1로 부팅을 중단하므로, 정책값을 바꿨다면 배포 전에 여기서 먼저 확인한다. 배포 대상과 다른 정책 파일을 검사하려면 `CLAWAD_POLICY_FILE`을 지정한다.

마지막 명령은 고정된 Prometheus·Alertmanager 이미지의 `promtool`과 `amtool`까지 실행하고 핵심 알림 시계열 fixture도 검증하므로, 최초 실행 시 해당 이미지를 내려받을 수 있어야 한다.

## 호스트 Node 런타임 (Node 24 이상)

배포·백업·복원 드릴 스크립트는 **호스트의 node**로 실행된다(컨테이너 안이 아니다). 저장소와 CI는 Node 24 기준이므로 호스트도 24 이상이어야 한다.

**Ubuntu 24.04의 apt `nodejs` 패키지는 18.x라 쓰지 않는다.** 신규 인스턴스는 `deploy/terraform/aws/user-data.sh`가 NodeSource로 24를 설치하지만, **user-data는 프로비저닝 때 한 번만 실행되므로 기존 호스트에는 적용되지 않는다.** 기존 호스트는 직접 올린다 (CLAW-193).

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get -o DPkg::Lock::Timeout=300 install -y nodejs
node -v   # v24.x 확인
```

`clawad-backup.service`가 `ExecStart`에 `/usr/bin/node`를 직접 지정하므로 **그 경로가 24가 되는 방식**이어야 한다. snap 설치는 경로가 달라 유닛이 옛 런타임을 계속 쓴다.

올린 뒤 실제로 도는지 확인한다.

```bash
sudo systemctl start clawad-backup.service && systemctl status clawad-backup.service --no-pager
npm run infra:prod:release-status
```

낮은 런타임에서는 `scripts/lib/production-compose.js`가 기동 시점에 명확한 오류로 멈춘다. 모든 운영 스크립트가 이 모듈을 거치므로, 조용히 깨지는 대신 배포가 시작 전에 실패한다.

## 최초 전환 배포

기존 API-only topology는 새 release 스크립트의 rollback 대상이 아니다. user-web 이전 SHA를 임의 retag하지 않는다. 최초 전환은 이 PR의 release plumbing을 담은 첫 commit을 **baseline commit**으로 보존하고, 다음 최종 commit과 분리해 아래 점검 창에서 2단계로 수행한다.

CLWD-72의 검증된 baseline commit은 `a15b0b85e23439b15185f691b2c4285d78d29398`이다. 이 SHA의 checkout과 이미지 label이 정확히 일치할 때만 최초 전환에 사용한다.

1. 기존 `.env`, checkout SHA, API·Caddy 실제 image ID와 Compose 파일을 접근 제한된 변경 기록에 보존하고 DB backup을 만든다.
2. baseline commit에서 API·user-web 이미지를 build하고 새 Compose topology를 수동 기동한다. 이 한 번의 단계가 실패하면 기존 checkout과 기록한 image ID로 API-only topology를 `--no-build` 복원하고 smoke한다. 새 release 스크립트를 legacy 복구에 사용하지 않는다.
3. baseline의 API·웹·edge health와 공개 smoke를 확인한 다음, 별도 최종 commit을 `RELEASE_SHA`, baseline commit을 `ROLLBACK_SHA`로 지정해 아래 표준 release 명령을 실행한다. 이 시점부터 세 component의 자동 rollback이 활성화된다.
4. 최종 release status가 `current=최종 commit`, `rollback=baseline commit`으로 일치하지 않으면 전환 완료로 보지 않는다.

baseline과 최종 commit을 분리할 수 없거나 기존 topology 복원 리허설을 하지 못하면 최초 전환을 진행하지 않는다.

1. 운영 호스트에 Docker Engine과 Compose v2를 설치하고 DNS A/AAAA를 연결한다. 방화벽에는 80/443만 공개한다.
2. 위 `.env`와 세 secret 파일을 준비한다. `API_DOMAIN`, `WEB_DOMAIN`, `PUBLIC_RELEASE_STAGE`, `ACME_EMAIL`을 설정한다. `CORS_ORIGINS`와 `SOCIAL_RETURN_ALLOWLIST`, 네 개의 `LEGAL_*_URL`은 실제 `https://WEB_DOMAIN`을 사용해야 한다.
3. CLAW-65 도입 전 API 이미지는 글로벌 긴급 중지를 이해하지 못하므로 rollback 대상으로 사용할 수 없다. 현재 운영 commit에 긴급 중지 gate만 먼저 backport한 별도 baseline commit을 검증·배포하고, Dockerfile이 생성한 두 image label을 확인한 뒤 그 commit을 `ROLLBACK_SHA`로 사용한다. 이 baseline 없이 최초 자동 배포를 시도하면 release 스크립트가 fail-closed로 거부한다.
4. 배포할 commit을 checkout하고 `npm run infra:prod:observability-check -- --containers`를 통과시킨다.
5. 아래 release 명령으로 백업, 이미지 build, 전체 서비스 기동, 공개 smoke test와 release 상태 기록을 한 번에 수행한다.

```bash
npm run infra:prod:deploy -- <RELEASE_SHA> <ROLLBACK_SHA> https://api.example.com https://app.example.com
npm run infra:prod:release-status
```

release 명령은 checkout과 `RELEASE_SHA`가 다르거나 작업 트리에 미커밋 파일이 있으면 중단한다. API, user-web, user-web 이미지에 포함된 HTTPS edge의 실제 image revision과 rollback label이 하나라도 다르면 부분 배포로 보고 중단한다. 성공 시 두 공개 origin의 health·정적 자산·release SHA·정책·법률 URL을 확인한 뒤 `BACKUP_DIR/release-state.json`과 접근 제한된 `.env`를 원자적으로 갱신한다. 실패하면 검증된 직전 이미지들을 재build하지 않고 함께 rollback하고 같은 공개 smoke test를 다시 수행한다.

### 디스크 회수 (CLAW-254)

배포는 검증과 상태 기록이 끝난 뒤 **옛 release 이미지를 지운다.** 보존하는 것은 두 세대(`RELEASE_SHA`·`ROLLBACK_SHA`)와 **실행 중 컨테이너가 쓰는 SHA**다. 마지막 항목이 admin-web을 지킨다 — 별도 compose 프로젝트라 release SHA와 무관하게 돌고, 지우면 재기동에서 죽는다.

`docker image prune -a`를 조건 없이 걸지 않는다. rollback 이미지는 실행 중 컨테이너가 없어 그대로 지워지는데, 다음 배포의 `inspectReleaseImages(rollbackSha)`가 그 이미지를 요구한다 — 지우면 배포가 거부되고 자동 rollback도 함께 죽는다.

**정리 실패는 배포를 세우지 않는다.** 디스크를 비우려는 단계가 배포를 막으면 디스크가 찰수록 고칠 방법이 사라진다. 실패는 로그로 남기고 넘어간다.

Prometheus는 기간(`PROMETHEUS_RETENTION`, 30d)과 크기(`PROMETHEUS_RETENTION_SIZE`, 3GB) 중 먼저 닿는 쪽에서 잘린다. 기간만 두면 짧은 기간에 시계열이 폭증할 때(부하테스트) 상한이 없다.

> 2026-08-20 실측 — 이 정리를 넣기 전 이미지 195개 18.12GB, 루트 88%(여유 3.7GB). 정리 후 15개 3.3GB, 37%(여유 18GB). 배포 1회당 0.3~0.4GB씩 늘고 있었다. `ClawadHostDiskLow`(여유 15% 미만)는 정상 발화했다 — 알림이 없어서가 아니라 아무도 조치하지 않아 88%까지 갔다.

API는 빈 DB에서 마이그레이션을 자동 적용한다. 마이그레이션은 전진 호환이어야 하며, 이전 애플리케이션이 새 스키마에서 동작하지 않는 변경은 이 절차로 배포하지 않는다.

소셜 로그인 운영 앱 공개와 외부 계정 검증은 [OAuth 운영 공개 런북](oauth-production.md)을 따른다.

## 알림 전달 경로 (alert-bridge)

Mattermost 수신 웹훅은 `{"text": ...}`만 처리하고 Alertmanager의 자체 페이로드는 HTTP 400으로 거부한다. 그래서 Alertmanager는 수신기로 직접 보내지 않고 내부 `alert-bridge`(`http://alert-bridge:9099/alert`)로만 보내며, 브리지가 형식을 변환해 수신기로 전달한다. 실제 수신기 URL은 브리지만 시크릿으로 보유하고 `alertmanager.yml`에는 두지 않는다.

브리지는 수신기 URL을 읽지 못하면 기동을 거부하고(fail-closed), 기동 후 시크릿이 사라지면 `/healthz`가 503을 반환해 컨테이너가 unhealthy로 바뀐다. 알림이 오지 않으면 다음 순서로 확인한다.

```bash
docker compose -f compose.yml ps alert-bridge
docker compose -f compose.yml logs --tail 50 alert-bridge
```

`수신기 거부 status=4xx`가 보이면 수신기 웹훅이 폐기·변경된 것이므로 시크릿 파일을 갱신하고 브리지를 **재생성**한다(`up -d --force-recreate alert-bridge`). Docker secret은 컨테이너 생성 시점에 주입되므로 `restart`로는 새 값이 반영되지 않는다.

> 시크릿 파일 권한 주의: compose의 `file:` 시크릿은 복사가 아니라 **bind mount**라 호스트 파일 권한이 실행 중인 컨테이너에 그대로 적용된다. 소비 컨테이너는 비root(`alert-bridge`·prometheus·alertmanager `65534`, api `1000`, grafana `472`)이므로 호스트 파일을 `0600 root`로 조이면 즉시 읽기 불가가 되어 알림·스크레이핑이 함께 끊긴다. 권한을 바꾸려면 소비자 UID를 먼저 확인한다.

## 관측 경계와 Grafana 접근

Prometheus는 backend 네트워크에서 `GET /monitor/v1/metrics`를 Bearer secret 파일로 수집한다. Caddy는 외부의 `/monitor`와 `/monitor/*`를 항상 404로 닫는다. 메트릭과 dashboard label에는 정해진 route family·상태·공급자·안전 오류 코드만 사용하며 토큰, 소셜 subject, 이메일, userId, machineId, URL·경로 파라미터, 프로젝트 경로와 프롬프트를 넣지 않는다.

Grafana는 기본 `127.0.0.1:3001`에만 열린다. 운영 호스트에 직접 public port를 추가하지 않고 SSH 터널을 사용한다.

```bash
ssh -L 3001:127.0.0.1:3001 <운영호스트>
```

로컬 브라우저에서 `http://127.0.0.1:3001`을 열고 `Clawad / Clawad 폐쇄 알파 운영` dashboard를 확인한다. 익명 접속과 회원가입은 꺼져 있다. Grafana·Prometheus·Alertmanager의 이름 volume은 일반 재기동에서 보존한다.

### SSM 전용 관리자 대시보드

관리자 대시보드는 공개 Caddy, DNS, security group에 경로를 추가하지 않는다. core release와 분리된 `admin-compose.yml`로만 기동하며 호스트의 `127.0.0.1:3002`에 바인딩한다. gateway가 없는 운영 backend와 별도로, 공개 edge와 격리된 관리자 전용 bridge가 host loopback publish 경로를 제공한다. 브라우저는 DB에 직접 접속하지 않고, 같은 origin의 `/admin/v1/*`와 `/internal/v1/*` 요청을 운영 Compose의 external backend 네트워크로 전달한다. 기존 관리자 JWT·RBAC·감사 로그가 그대로 적용되므로 SSM 세션을 열었더라도 관리자 로그인이 필요하다.

배포할 checkout에서 정확한 commit SHA를 이미지 label에 넣어 독립적으로 빌드·기동한다. core API release/rollback과 결합하지 않기 위해 일반 compose 기동에는 포함되지 않는다. dirty checkout은 HEAD와 이미지 내용이 달라지므로 배포하지 않는다.

```bash
set -euo pipefail
test -z "$(git status --porcelain)"
export ADMIN_WEB_RELEASE_SHA="$(git rev-parse HEAD)"
test "${#ADMIN_WEB_RELEASE_SHA}" -eq 40
case "$ADMIN_WEB_RELEASE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
docker compose --env-file deploy/production/.env -f deploy/production/admin-compose.yml build admin-web
test "$(docker image inspect "clawad-admin-web:$ADMIN_WEB_RELEASE_SHA" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$ADMIN_WEB_RELEASE_SHA"
docker compose --env-file deploy/production/.env -f deploy/production/admin-compose.yml up -d --wait admin-web
curl --fail http://127.0.0.1:3002/healthz
test "$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3002/internal/v1/analytics/alpha-overview)" = 401
```

접속 권한이 있는 운영자는 로컬에서 AWS Session Manager port forwarding을 연다.

```bash
aws ssm start-session \
  --region ap-northeast-2 \
  --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=3002,localPortNumber=3002
```

세션이 열린 동안에만 로컬 브라우저에서 `http://127.0.0.1:3002`로 접속한다. IAM의 `ssm:StartSession` 권한과 Session Manager 감사 로그를 정기적으로 검토해 본인 외 접근 주체가 없는지 확인한다.

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
npm run infra:prod:deploy -- <새_RELEASE_SHA> <현재_RELEASE_SHA> https://api.example.com https://app.example.com
npm run infra:prod:release-status
```

상태 명령은 다음 세 소스를 대조한다.

1. 실행 중 container의 실제 image ID에 구워진 OCI `org.opencontainers.image.revision` label
2. container에 설정된 `ai.clawad.rollback-revision` label
3. `.env`와 `BACKUP_DIR/release-state.json`

불일치하면 재기동하지 말고 배포 기록과 실제 이미지부터 확인한다. `docker inspect` 전체 출력에는 환경변수가 포함될 수 있으므로 운영 티켓에 붙이지 않는다. 상태 스크립트는 안전한 두 commit SHA만 출력한다.

명시적 rollback은 다음과 같이 수행한다.

```bash
npm run infra:prod:rollback -- https://api.example.com https://app.example.com
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
