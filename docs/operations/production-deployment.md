# 운영 배포·백업·복구 절차

알파 출시 전 OS·OAuth·광고 전체 흐름 판정은 [알파 E2E Go/No-Go 런북](./alpha-e2e-runbook.md)을 따른다.

이 문서는 단일 호스트의 Docker Compose 운영 기준이다. 실제 비밀값과 `.env`는 저장소가 아닌 비밀 관리자에서 주입하며, 데이터베이스와 Redis 포트는 외부에 공개하지 않는다.

## 최초 배포

1. 운영 호스트에 Docker Engine과 Compose v2를 설치하고 DNS A/AAAA 레코드를 호스트로 연결한다. 방화벽에서는 80/443만 공개한다.
2. `deploy/production/.env.example`을 호스트의 접근 제한된 경로로 복사한다. 네 개의 서명 키는 각각 32바이트 이상의 난수로 따로 생성한다. DB·Redis·OAuth·관리자 자격 증명도 비밀 관리자에서 주입한다.
3. `API_DOMAIN`, `ACME_EMAIL`, 명시적인 HTTPS `CORS_ORIGINS`와 `SOCIAL_RETURN_ALLOWLIST`를 설정한다.
4. `npm run infra:prod:config`와 `npm run infra:prod:build` 후 `docker compose -f deploy/production/compose.yml up -d --wait`를 실행한다. API는 빈 DB에서 마이그레이션을 자동 적용한다.
5. `npm run infra:prod:smoke -- https://api.example.com`으로 공개 HTTPS와 DB·Redis 준비 상태를 확인한다.

소셜 로그인 운영 앱 공개와 외부 계정 검증은 [OAuth 운영 공개 런북](oauth-production.md)을 따른다.

`docker compose config` 결과에는 치환된 비밀값이 포함될 수 있다. 결과를 파일·CI 아티팩트·채팅에 남기지 않고 `--quiet` 검증만 사용한다. 애플리케이션 오류 응답과 상태 확인 API도 자격 증명이나 내부 접속 정보를 반환하지 않는다.

## 최초 관리자 부트스트랩 종료

최초 한 번만 `ADMIN_BOOTSTRAP_ENABLED=true`와 임시 관리자 자격 증명을 주입해 기동한다. 실제 관리자 계정을 생성하고 로그인을 확인한 다음 `ADMIN_BOOTSTRAP_ENABLED=false`로 바꾸고 `ADMIN_BOOTSTRAP_PASSWORD`를 비밀 관리자에서도 삭제한 뒤 API를 재배포한다. 운영 검증기는 비활성화된 임시 비밀번호가 남아 있으면 기동을 거부한다.

## 백업과 격리 복구 드릴

배포 전과 매일 `npm run infra:prod:backup`을 실행한다. 결과는 `BACKUP_DIR`에 custom-format dump와 SHA-256 manifest로 생성된다. 백업은 호스트 밖의 암호화된 저장소로 복제하고 보존·접근 정책을 별도로 적용한다.

```bash
npm run infra:prod:backup
npm run infra:prod:restore-drill -- clawad-YYYYMMDDTHHMMSSZ.dump
```

복구 드릴은 먼저 dump의 해시를 manifest와 비교한 뒤 tmpfs를 쓰는 격리된 PostgreSQL에만 복원하고, 광고 과금·리워드·노출·감사 원장을 실제로 조회해 구조와 합계를 검증한다. 운영 DB를 수정하지 않는다. 분기마다 최신 백업으로 드릴을 실행하고 성공 기록과 소요 시간을 운영 기록에 남긴다.

Redis는 AOF `appendfsync=always`와 영속 볼륨을 사용한다. 호스트/클라우드 볼륨 스냅샷도 암호화해 보관한다. 재기동 후 세션이 유지되는지는 별도의 지속성 테스트로 확인하되, PostgreSQL 원장을 재구성 가능한 사실의 최종 원본으로 취급한다.

## 재배포와 롤백

배포 전 DB 백업을 만들고 이미지에는 변경 불가능한 커밋 태그를 사용한다. 새 `IMAGE_TAG`로 build/up 후 상태 확인을 실행한다. 애플리케이션 롤백은 이전 `IMAGE_TAG`로 다시 `up -d --wait`한다. 마이그레이션은 기본적으로 전진 호환으로 작성하며, 비호환 DB 변경은 별도 점검 창과 복구 계획 없이 배포하지 않는다. 데이터 복구가 필요하면 서비스를 쓰기 차단한 뒤 검증된 백업을 새 DB에 복원하고 원장 합계를 비교해 접속 대상을 전환한다.

운영 데이터가 있는 환경에서 `docker compose down -v`를 실행하지 않는다. 일반 `down`과 재기동은 명명된 PostgreSQL·Redis 볼륨을 보존한다.
