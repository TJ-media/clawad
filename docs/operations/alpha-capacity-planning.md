# 알파 용량 계획과 자원 가드레일 (CLAW-76)

폐쇄형 알파는 **t4g.small 한 대**(2 vCPU, 2GB RAM, ARM64/Graviton)에서 API·user-web/edge·PostgreSQL·Redis·Prometheus·Alertmanager·Grafana를 함께 운영한다. Compose에 자원 한도가 없으면 배포·백업·관측성 작업이 겹칠 때 swap 폭주나 OOM으로 전체 서비스가 함께 중단될 수 있다. 이 문서는 부하 시나리오, 서비스별 자원 배분과 근거, 임계치·대응, 인스턴스 크기·비용 결정을 정의한다.

관련: CLAW-59(운영 배포), CLAW-64(알파 E2E), CLAW-65(모니터링·알림), CLAW-72(user-web 운영).

---

## 1. 부하 시나리오 (20~50명 알파)

| 시나리오 | 설명 | 동시성 가정 |
| --- | --- | --- |
| 정상 | 20~50명이 산발적으로 광고 sync·로그인·리워드 조회 | 초당 수 건 이하 API, sync는 클라이언트당 분 단위 |
| 피크 | 초대 직후·공지 직후 다수가 동시에 로그인·설치·최초 sync | 짧은 스파이크(수십 req/s), OAuth·이벤트 업로드 집중 |
| 배포 동시 | 피크 중 릴리스(이미지 빌드·마이그레이션·재기동) 겹침 | API 재기동 + 헬스체크 + 트래픽 |
| 백업 동시 | 정기 pg_dump·체크섬·(CLAW-75)외부 업로드가 트래픽과 겹침 | PostgreSQL I/O·CPU 상승 |

핵심 요구: **어떤 조합에서도 로그인·광고 sync·포인트·교환 API가 정상 동작**해야 한다. 관측성(Prometheus/Grafana/cadvisor 등) 장애가 이 핵심 경로를 중단시키면 안 된다.

## 2. 서비스별 자원 배분 (초기 가드레일)

`deploy/production/compose.yml`의 `deploy.resources`와 `oom_score_adj`로 강제한다. 값은 **초기 가드레일**이며, node-exporter·cadvisor 실측(§4)으로 조정한다.

| 서비스 | 메모리 상한 | 예약 | CPU 상한 | oom_score_adj | 분류 |
| --- | --- | --- | --- | --- | --- |
| postgres | 512M | 256M | 0.80 | -800 | 핵심(원장) |
| redis | 256M | 96M | 0.40 | -800 | 핵심(세션·토큰·rate limit) |
| api | 512M | 192M | 0.80 | -600 | 핵심(앱) |
| caddy(edge) | 128M | 48M | 0.40 | -600 | 핵심(TLS 종단) |
| user-web | 96M | — | 0.30 | 0 | 정적 서빙 |
| prometheus | 300M | — | 0.40 | 600 | 관측성 |
| alertmanager | 64M | — | 0.20 | 500 | 관측성(알림 송신) |
| grafana | 192M | — | 0.30 | 800 | 관측성(사후 조회) |
| node-exporter | 64M | — | 0.20 | 300 | 관측성(호스트) |
| cadvisor | 160M | — | 0.30 | 300 | 관측성(컨테이너) |
| postgres-restore | 512M | — | 0.80 | — | 복구 리허설(profile, 평시 미실행) |

**설계 원칙**

- **핵심에만 예약(reservations)** 을 두어 최소 메모리를 보장한다. 관측성은 상한만 두고 압박 시 양보한다.
- **`oom_score_adj`로 축출 순서를 제어**한다: 메모리가 부족하면 커널은 grafana(800)→prometheus(600)→alertmanager(500)→exporter(300) 순으로 먼저 죽이고, 핵심(postgres/redis −800, api/caddy −600)은 가장 나중에 죽인다. 즉 관측성 장애가 핵심 경로를 중단시키지 않는다.
- **상한 합은 물리 메모리(2GB)를 초과**한다(약 2.4GB). 이는 의도된 오버서브스크립션이다 — 모든 서비스가 동시에 상한에 도달하는 일은 드물고, 예약 합(592M)은 물리 메모리 안에 있어 핵심은 항상 보장된다. 상한은 "특정 컨테이너 폭주가 전체를 끌어내리지 않게" 하는 안전벨트다.
- 상시 실행 서비스에 관측성 풀스택 + 2개 exporter까지 얹으면 2GB는 빠듯하다. §4 실측에서 여유가 부족하면 grafana를 외부/온디맨드로 분리하거나 t4g.medium 상향을 검토한다(§5).

## 3. 임계치와 대응

`deploy/production/observability/alerts.yml`의 `clawad-infra` 그룹이 감시한다(node-exporter·cadvisor 메트릭).

| 알림 | 조건 | 심각도 | 대응 |
| --- | --- | --- | --- |
| ClawadHostMemoryLow | 가용 메모리 < 10% (5m) | critical | 배포·백업 동시 실행 중단, 관측성 일시 축소, 원인 컨테이너 확인 |
| ClawadHostSwapActive | swap 사용률 > 25% (10m) | warning | 메모리 압박 원인 제거, 한도 재조정 검토 |
| ClawadHostDiskLow | 루트 여유 < 15% (5m) | warning | 로그·메트릭·백업 보존 정리(§6), 디스크 증설 |
| ClawadHostCpuSaturated | CPU > 90% (15m) | warning | 부하 원인 확인. **CPU 크레딧 잔량은 CloudWatch `CPUCreditBalance` 알람으로 별도 감시**(버스터블 전용, Prometheus 미수집) |
| ClawadHostOOMKilled | 커널 OOM kill 발생(15m) | critical | 축출된 프로세스·한도·oom_score_adj 확인, 재발 시 상향 |
| ClawadContainerMemoryHigh | 컨테이너가 한도의 90% (5m) | warning | 해당 컨테이너 한도 조정 또는 원인 점검 |
| ClawadContainerRestarting | 15분간 2회 초과 재시작 | warning | OOM 축출·크래시 루프 확인 |

> **CPU 크레딧**: t4g는 버스터블 인스턴스로, CPU 크레딧이 소진되면 기준 성능(baseline)으로 떨어진다. 이 잔량은 EC2/CloudWatch 전용 메트릭이라 Prometheus로 직접 볼 수 없다. `CPUCreditBalance` CloudWatch 알람(예: < 30)을 별도로 구성하고, Prometheus의 `ClawadHostCpuSaturated`(지속 고사용)를 조기 신호로 병행한다.

## 4. 실측·부하 검증 절차 (운영 환경)

로컬에서는 설정·규칙·문법만 검증할 수 있다(§7). 실제 용량 판정은 운영 환경에서 수행한다.

1. 배포 후 정상 트래픽 하루 관측: cadvisor `container_memory_working_set_bytes`, node-exporter 메모리/swap/디스크로 서비스별 실사용 확인.
2. 피크 재현: 다수 계정으로 동시 로그인·최초 sync·이벤트 업로드를 유발하고 API p95 지연·5xx·이벤트 거절률을 본다.
3. 배포·백업 동시: 피크 중 릴리스와 pg_dump를 겹쳐 실행해 OOM·swap·헬스체크 실패가 없는지 확인한다.
4. 장애 주입: 관측성 컨테이너에 메모리 부하를 걸어 **관측성만 축출되고 핵심 원장·API가 유지**되는지, 재시작 후 원장 무결성(건수·잔액·교환 상태)이 보존되는지 확인한다.
5. 실측값으로 §2 한도를 조정하고 이 문서를 갱신한다.

## 5. 인스턴스 크기·비용 결정

| 옵션 | 구성 | 월 예상 비용(ap-northeast-2, 온디맨드 기준) | 판단 |
| --- | --- | --- | --- |
| **t4g.small 유지 (채택)** | 2GB, 자원 한도+축출 순서로 OOM 방지, 관측성 상한 | 약 US$12/월 + EBS | 알파 규모(20~50명)에 비용 최소. 채택 |
| t4g.medium 상향 | 4GB, 여유 확보 | 약 US$24/월 + EBS | §4 실측에서 상한 조정으로도 여유가 안 나면 상향 |
| 관측성 분리 | Grafana/Prometheus 외부·온디맨드 | 추가 비용·운영 복잡 | 알파 단계에는 과함. 후속 |

- **채택: t4g.small 유지.** `deploy/terraform/aws`의 `instance_type` 기본값(t4g.small)을 유지하고, 자원 한도·축출 순서로 OOM을 방지한다.
- **상향 트리거**: §4 실측에서 (a) 핵심 예약을 확보하면 관측성이 상시 상한에 눌려 대시보드·알림이 불안정하거나, (b) 정상 트래픽에서도 swap이 지속되거나, (c) OOM kill이 반복되면 → `instance_type = "t4g.medium"`으로 상향한다(terraform 변수만 변경, 검증된 값). 비용은 약 2배.

## 6. 디스크·보존 정책

- Prometheus TSDB: `PROMETHEUS_RETENTION`(기본 30d)로 상한. 디스크 여유 부족 시 축소.
- 백업: `BACKUP_DIR` 누적 관리(CLAW-75 외부 복제·보존 정책과 연계).
- 컨테이너 로그: Docker json-file 로그가 무한 증가하지 않도록 로테이션(`max-size`/`max-file`)을 데몬 또는 서비스 단위로 설정한다(후속 점검 항목).
- `ClawadHostDiskLow`로 루트 디스크를 감시하고, 증가 추세는 Grafana에서 확인한다.

## 7. 로컬 검증

```bash
npm run infra:prod:observability-check              # compose config + 필수 규칙·scrape 대상 존재
npm run infra:prod:observability-check -- --containers  # 위 + promtool로 alerts.yml·alerts.test.yml 동작, amtool 구성 검증
```

- 자원 한도·`oom_score_adj`·exporter 추가 후에도 compose 구성이 유효해야 한다.
- 신규 `clawad-infra` 알림 규칙은 `alerts.test.yml`의 promtool 테스트로 발화·비발화를 검증한다.
- 실제 OOM·부하·CPU 크레딧 소진은 운영 환경에서만 재현·판정한다(§4).
