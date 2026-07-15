# AWS 서울 운영 인프라

CLWD-60의 운영 OAuth 공개에 앞서 클로애드 API를 서울 리전(`ap-northeast-2`)에 배포하기 위한 Terraform 구성이다. 기본값은 Ubuntu 24.04 ARM64와 `t4g.small`, 암호화된 gp3 30GiB다.

## 생성 리소스

- 서울 기본 VPC·기본 서브넷의 EC2 1대
- Canonical SSM 공개 파라미터가 가리키는 최신 Ubuntu 24.04 LTS ARM64 AMI
- HTTP 80·HTTPS 443만 공개하는 보안 그룹
- Session Manager용 IAM 역할과 인스턴스 프로파일
- 고정 DNS 연결용 Elastic IP
- 선택적인 Route 53 A 레코드

첫 부팅 때 Docker Engine, Compose v2, Git, SSM Agent를 준비하고 2GiB swap을 만든다. 애플리케이션 시크릿과 `deploy/production/.env`는 Terraform이나 user data에 넣지 않는다.

user data는 최초 부팅 준비용이며 이후 파일 변경이 기존 인스턴스에 자동 적용되지는 않는다. 변경 사항은 검증된 운영 배포 절차나 Session Manager로 적용한다. 최신 AMI 파라미터가 바뀌어도 Terraform이 운영 인스턴스를 자동 교체하지 않으며, AMI 갱신은 외부 백업과 복구 시험을 마친 유지보수 창에서만 수행한다.

## 준비

Terraform 1.7 이상과 인증된 AWS CLI 자격 증명이 필요하다. 관리자 장기 액세스 키 대신 AWS IAM Identity Center(SSO) 또는 단기 자격 증명을 권장한다.

```bash
cd deploy/terraform/aws
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform fmt -check
terraform validate
terraform plan -out=tfplan
terraform apply tfplan
```

`terraform.tfvars`, state, plan 파일은 Git에 올리지 않는다. Terraform state에는 인프라 식별 정보가 들어 있으므로 접근 제한된 위치에 보관하고 암호화된 별도 저장소에 백업한다. 여러 관리자가 동시에 적용하기 전에는 S3 버저닝·암호화·잠금을 사용하는 원격 backend로 이전한다.

SSH는 기본적으로 닫혀 있다. AWS 콘솔의 `EC2 > 인스턴스 > 연결 > Session Manager`를 사용한다. SSH가 꼭 필요하면 로컬에서 공개키를 만들고 `terraform.tfvars`에 공개키와 장소별 `/32` CIDR만 입력한다.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/clawad-prod-seoul
```

개인키 파일 내용은 Terraform, Git, Jira, 메신저에 입력하지 않는다.

## DNS와 HTTPS

`terraform output public_ip`의 주소를 외부 DNS의 API 도메인 A 레코드로 등록한다. Route 53을 사용한다면 `route53_record`를 설정해 Terraform이 레코드를 생성하게 할 수 있다. DNS 전파 후 `deploy/production/.env`의 `API_DOMAIN`과 OAuth 운영 콜백을 같은 HTTPS 도메인으로 맞춘다.

## 기존 버지니아 인스턴스

이 구성은 서울 리소스만 관리하며 버지니아 북부 인스턴스를 가져오거나 삭제하지 않는다. 서울 인스턴스와 Session Manager 접속을 확인한 뒤 기존 인스턴스의 종료 방지를 해제하고 종료한다. 연결된 EBS, Elastic IP, 스냅샷이 남았는지도 버지니아 리전에서 별도로 확인한다.

## 비용과 삭제

EC2 무료 시간과 크레딧은 계정 단위로 합산된다. Elastic IP, EBS, 스냅샷, 데이터 전송, 초과 CPU 크레딧은 별도 비용이 될 수 있다. `terraform apply` 전에 plan을 확인하고 AWS Budgets 알림을 설정한다.

운영 데이터가 생긴 뒤에는 먼저 외부 백업과 복구 검증을 완료한다. 이후에만 다음 명령으로 인프라를 제거한다.

```bash
terraform apply -var='enable_termination_protection=false'
terraform destroy -var='enable_termination_protection=false'
```
