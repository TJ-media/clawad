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
- **저장 암호화**: SSE-KMS의 **AWS 관리 키(`aws/s3`)** (CLAW-192). `bucket_key_enabled`로 KMS 호출을 버킷 단위로 묶어 요청 비용을 무료 한도 안에 둔다. 키 보관료는 없다.
  - SSE-S3(AES256)를 쓰지 않는 이유: 버킷 접근 권한만 있으면 복호화된 내용이 그대로 나와 사실상 물리적 디스크 유출만 막는다. KMS는 S3 읽기 권한과 복호화 권한이 분리되어 **버킷이 실수로 공개돼도 익명 요청이 읽지 못한다.**
  - 클라이언트 사이드 암호화(age·GPG)는 채택하지 않았다. 키를 잃으면 백업이 영구 소실되어 단일 장애점이 되고, 복원 드릴이 호스트에서 실행되므로 키를 호스트에 두어야 해 이점이 대부분 사라진다.
  - **고객 관리 키(CMK, 월 $1)는 복원 권한 분리를 설계할 때 도입한다.** CMK는 키 정책이 허용 목록이라 "인스턴스 역할은 암호화만, 복호화는 사람이 assume하는 역할만"을 강제할 수 있다. AWS 관리 키는 IAM Deny로만 가능해 누락 위험이 있다. 도입 시 `BACKUP_S3_SSE_KMS_KEY_ID`를 채우고 terraform의 버킷 기본 암호화·IAM 정책을 함께 바꾼다.
  - 암호화 설정을 바꿔도 **이미 올라간 객체는 재암호화되지 않는다.** 새 백업부터 적용되며 수명주기로 자연히 교체된다.
  - 인스턴스 역할에는 `kms:ViaService`로 S3 경유 호출에만 한정한 `kms:GenerateDataKey`·`kms:Decrypt`를 준다. `Decrypt`가 필요한 이유는 업로드 후 체크섬 재검증이 객체를 다시 내려받기 때문이다.
- **전송 암호화 강제**: 버킷 정책이 `aws:SecureTransport=false` 요청을 거부한다.
- **보존/삭제**: 현재본 `backup_retention_days`(기본 90일) 후 만료, 비현재본 `backup_noncurrent_retention_days`(기본 30일), 미완료 멀티파트 7일 정리.
- **최소 권한**: 기존 인스턴스 역할(`ssm`)에 대상 버킷 한정 `s3:ListBucket`·`s3:PutObject`·`s3:GetObject`만 부여한다. **`s3:DeleteObject`는 부여하지 않는다** — 삭제는 수명주기 정책이 담당해 자격증명 오남용·실수 삭제를 막는다. 인스턴스 역할이라 코드가 액세스 키를 다루지 않는다.

## 3. 설정 (`deploy/production/.env.example`)

| 변수 | 뜻 |
| --- | --- |
| `BACKUP_S3_BUCKET` | 복제 대상 버킷. 비우면 로컬 백업만 |
| `BACKUP_S3_PREFIX` | 객체 키 프리픽스(기본 `postgres`). 키는 `prefix/YYYY/MM/파일` |
| `BACKUP_S3_SSE` | 저장 암호화. 기본 `aws:kms` |
| `BACKUP_S3_SSE_KMS_KEY_ID` | 비우면 AWS 관리 키(`aws/s3`). CMK 도입 시에만 채운다 |
| `NODE_EXPORTER_TEXTFILE_DIR` | 백업 성공 메트릭을 남길 호스트 디렉토리 |
| `BACKUP_LOCAL_RETENTION_DAYS` | 로컬 dump 보존일(기본 14). 초과분은 백업 후 삭제 |

> 이 값들은 systemd 타이머(`EnvironmentFile`)와 배포 경로(`production-release.js`의 `BACKUP_ENV_KEYS`) **양쪽에서** 전달된다. 예전에는 배포 경로가 `BACKUP_DIR`만 넘겨서, 배포가 실행한 백업은 dump만 만들고 외부 복제도 메트릭 기록도 하지 않았다 (CLAW-192). 새 백업 환경변수를 추가하면 그 허용목록에도 넣어야 하며, `test/production-infra.test.js`가 두 곳의 어긋남을 검사한다.

## 4. 백업 실행과 체크섬 검증

```bash
npm run infra:prod:backup
```

1. `pg_dump --format=custom`으로 백업 생성, 로컬에서 SHA-256 manifest 작성.
2. 백업·manifest를 S3에 업로드(SSE·TLS).
3. **업로드 후** 원격 객체를 임시로 내려받아 해시를 manifest와 대조한다 — 다르면 실패로 처리하고 복제를 신뢰하지 않는다.
4. `NODE_EXPORTER_TEXTFILE_DIR`에 `clawad_backup.prom`을 원자적으로 기록(마지막 성공 시각·크기·검증 결과).

5. 보존일(`BACKUP_LOCAL_RETENTION_DAYS`, 기본 14)이 지난 **로컬** dump와 manifest를 삭제한다. 파일명 규약(`clawad-<타임스탬프>.dump`)을 통과한 파일만 지우고, 방금 만든 백업은 항상 남긴다. 외부 복제본은 S3 수명주기가 따로 관리한다.

### 정기 실행 (systemd timer)

수동 실행과 배포 시 실행만으로는 RPO를 보장할 수 없다. 저장소의 unit을 설치한다 (`terraform` user-data가 신규 호스트에서는 자동으로 수행한다).

```bash
sudo install -m 0644 /opt/clawad/deploy/production/systemd/clawad-backup.service /etc/systemd/system/
sudo install -m 0644 /opt/clawad/deploy/production/systemd/clawad-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawad-backup.timer
systemctl list-timers clawad-backup.timer
```

매일 03:15(±15분)에 실행하고 `Persistent=true`라 재부팅으로 놓친 실행은 부팅 후 따라잡는다. 실패는 재시도하지 않고 종료 상태로 남겨 아래 백업 경보가 잡게 한다.

## 5. 모니터링·알림

node-exporter textfile collector가 백업 메트릭을 노출하고 `deploy/production/observability/alerts.yml`이 감시한다.

| 알림 | 조건 | 심각도 |
| --- | --- | --- |
| ClawadBackupStale | 마지막 성공 백업이 26시간 초과 | critical |
| ClawadBackupMetricMissing | 메트릭이 30분 넘게 수집되지 않음(`absent()`) | critical |
| ClawadBackupUploadUnverified | 업로드 후 체크섬 재검증이 성공(1)이 아님 | warning |

> `ClawadBackupStale`은 메트릭이 **아예 없으면 평가되지 않아** 영원히 침묵한다. 백업이 한 번도 성공하지 못했거나 textfile이 삭제된 경우가 이에 해당하며, `ClawadBackupMetricMissing`이 그 구멍을 덮는다 (CLAW-185).

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
