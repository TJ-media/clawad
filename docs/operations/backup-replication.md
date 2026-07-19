# 운영 백업 외부 복제와 복구 (CLAW-75)

운영 백업이 운영 DB와 같은 EC2/EBS에만 있으면 인스턴스·볼륨 장애 시 원장과 백업을 함께 잃는다. 이 문서는 PostgreSQL 백업을 **EC2와 독립된 암호화 S3 버킷으로 자동 복제**하고, 격리 환경에서 복구를 검증하며, 백업 지연·실패를 감시하는 절차를 정의한다.

관련: CLAW-45(Redis 영속화), CLAW-59(운영 배포·복구 목표), CLAW-65(모니터링·알림).

---

## 1. 아키텍처

```
pg_dump(custom) → 로컬 BACKUP_DIR + manifest(sha256)
                → S3 업로드(TLS 전송·SSE 저장)
                → 업로드 후 재다운로드 해시 대조(전송 손상 탐지)
                → node-exporter textfile 메트릭(마지막 성공 시각·크기·검증)
```

- 구현: [`scripts/production-backup.js`](../../scripts/production-backup.js), 공용 로직 [`scripts/lib/backup-replication.js`](../../scripts/lib/backup-replication.js).
- 무의존성: node 내장 + `aws` CLI(spawn). AWS SDK를 추가하지 않는다(docker CLI 래퍼와 같은 패턴).
- `BACKUP_S3_BUCKET`이 비어 있으면 로컬 백업만 수행한다(개발·기존 동작 유지).

## 2. 저장소·IAM (terraform)

[`deploy/terraform/aws/s3-backup.tf`](../../deploy/terraform/aws/s3-backup.tf). `backup_bucket_name`을 설정하면 리소스를 만든다.

- **퍼블릭 차단**: `public_access_block` 4종 모두 true.
- **버전 관리**: 실수 삭제·덮어쓰기 보호.
- **저장 암호화**: SSE-S3(AES256) 기본, `bucket_key_enabled`. 고객 관리 키가 필요하면 KMS로 교체하고 스크립트 `BACKUP_S3_SSE=aws:kms`·`BACKUP_S3_SSE_KMS_KEY_ID`도 함께 바꾼다.
- **전송 암호화 강제**: 버킷 정책이 `aws:SecureTransport=false` 요청을 거부한다.
- **보존/삭제**: 현재본 `backup_retention_days`(기본 90일) 후 만료, 비현재본 `backup_noncurrent_retention_days`(기본 30일), 미완료 멀티파트 7일 정리.
- **최소 권한**: 기존 인스턴스 역할(`ssm`)에 대상 버킷 한정 `s3:ListBucket`·`s3:PutObject`·`s3:GetObject`만 부여한다. **`s3:DeleteObject`는 부여하지 않는다** — 삭제는 수명주기 정책이 담당해 자격증명 오남용·실수 삭제를 막는다. 인스턴스 역할이라 코드가 액세스 키를 다루지 않는다.

## 3. 설정 (`deploy/production/.env.example`)

| 변수 | 뜻 |
| --- | --- |
| `BACKUP_S3_BUCKET` | 복제 대상 버킷. 비우면 로컬 백업만 |
| `BACKUP_S3_PREFIX` | 객체 키 프리픽스(기본 `postgres`). 키는 `prefix/YYYY/MM/파일` |
| `BACKUP_S3_SSE` | 저장 암호화(`AES256` 기본, `aws:kms`) |
| `BACKUP_S3_SSE_KMS_KEY_ID` | KMS 사용 시 키 |
| `NODE_EXPORTER_TEXTFILE_DIR` | 백업 성공 메트릭을 남길 호스트 디렉토리 |

## 4. 백업 실행과 체크섬 검증

```bash
npm run infra:prod:backup
```

1. `pg_dump --format=custom`으로 백업 생성, 로컬에서 SHA-256 manifest 작성.
2. 백업·manifest를 S3에 업로드(SSE·TLS).
3. **업로드 후** 원격 객체를 임시로 내려받아 해시를 manifest와 대조한다 — 다르면 실패로 처리하고 복제를 신뢰하지 않는다.
4. `NODE_EXPORTER_TEXTFILE_DIR`에 `clawad_backup.prom`을 원자적으로 기록(마지막 성공 시각·크기·검증 결과).

정기 실행은 운영 호스트의 cron/systemd timer로 하루 1회 이상 수행한다(RPO=백업 주기).

## 5. 모니터링·알림

node-exporter textfile collector가 백업 메트릭을 노출하고 `deploy/production/observability/alerts.yml`이 감시한다.

| 알림 | 조건 | 심각도 |
| --- | --- | --- |
| ClawadBackupStale | 마지막 성공 백업이 26시간 초과 | critical |
| ClawadBackupUploadUnverified | 업로드 후 체크섬 재검증이 성공(1)이 아님 | warning |

> 백업이 한 번도 실행되지 않아 메트릭 자체가 없으면 `ClawadBackupStale`은 평가되지 않는다. 최초 배포 시 백업을 1회 실행해 메트릭을 초기화하고, 필요하면 `absent()` 규칙을 추가한다.

## 6. 복구 범위

- **PostgreSQL(핵심 원장)**: S3 백업에서 전량 복구한다. 광고 이벤트·과금·리워드·지급·교환·감사로그 등 모든 원장이 여기에 있다.
- **Redis**: 세션·serveToken registry·rate limit·빈도 카운터 등 **재생성 가능한 휘발성 데이터**다. 별도 외부 복제 대상이 아니다 — 손실 시 사용자 재로그인·토큰 재발급으로 회복되며 원장 무결성에 영향이 없다. (AOF 로컬 영속은 CLAW-45.)
- **운영 설정·시크릿**: `.env`·시크릿 파일은 백업에 포함하지 않는다. 비밀 관리자에서 재주입한다(백업·로그에 시크릿을 남기지 않는 원칙, §8).

## 7. 복구 리허설과 재해 복구

격리 환경(별도 `postgres-restore` 컨테이너, profile `restore-drill`)에서 검증한다. 운영 DB를 건드리지 않는다.

```bash
# 로컬 백업으로 리허설
npm run infra:prod:restore-drill -- clawad-YYYYMMDDTHHMMSSZ.dump
# 외부 저장소(S3)에서 내려받아 리허설 — EC2/EBS 손실 시나리오
npm run infra:prod:restore-drill -- --from-s3 clawad-YYYYMMDDTHHMMSSZ.dump
```

- 다운로드(해당 시) → 해시 검증 → 격리 복구 → 원장 무결성 스냅샷(건수·잔액) → 소요시간 기록 → 컨테이너 정리.
- **RPO**: 백업 주기(권장 24h 이하). **RTO**: 인스턴스 재프로비저닝 + S3 복원 + 마이그레이션 시간. 리허설의 소요시간 기록으로 실측·갱신한다.
- 실제 재해 복구는 새 인스턴스에서 terraform 재적용 → S3 최신 백업 복원 → 서비스 기동 순으로 수행하고, 절차·소요시간을 이 문서에 갱신한다.

## 8. 시크릿 비포함 검증

- 백업 파일(pg_dump)은 DB 데이터만 담으며 애플리케이션 env 시크릿(JWT·소셜 client secret 등)을 포함하지 않는다.
- 스크립트가 남기는 **로그·manifest·메트릭**은 `assertNoSecrets`가 AWS 키·DB 접속 문자열·JWT·비밀번호 대입 패턴을 검사해 유출을 차단한다(발견 시 원문을 재노출하지 않고 거부).
- aws CLI 자격증명은 인스턴스 역할로 제공되어 코드·환경변수에 키를 두지 않는다.

## 9. 로컬 검증 (이 변경으로 가능한 범위)

```bash
npm test                                            # 순수 로직(파일명·키·시크릿 스캔·메트릭) 단위 테스트
npm run infra:prod:observability-check -- --containers   # compose config + promtool(백업 규칙 포함) + amtool
terraform -chdir=deploy/terraform/aws validate      # (terraform CLI 있을 때) S3·IAM HCL 검증
```

실제 S3 업로드·다운로드·복구, IAM 권한 적용, 알림 발화는 **운영 환경(AWS 자격증명·배포된 스택)에서만** 재현·판정한다. 이번 변경은 스크립트·terraform·알림 규칙·문서·순수 로직 테스트까지 커버한다.
