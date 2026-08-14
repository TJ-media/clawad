#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if command -v snap >/dev/null 2>&1; then
  snap install amazon-ssm-agent --classic || true
  systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
fi

apt-get -o DPkg::Lock::Timeout=300 update
apt-get -o DPkg::Lock::Timeout=300 install -y docker.io docker-compose-v2 git curl ca-certificates unzip
systemctl enable --now docker
usermod -aG docker ubuntu

# aws CLI는 백업 외부 복제(scripts/lib/backup-replication.js)가 spawn하는 실행 파일이다 (CLAW-185).
# Ubuntu 24.04에는 apt awscli 패키지가 없어(설치 후보 없음) 공식 v2 설치기를 쓴다 (CLAW-198).
# /usr/local/bin은 systemd 기본 PATH에 포함되므로 clawad-backup.service가 그대로 찾는다.
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
  unzip -qo /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/awscliv2.zip /tmp/aws
fi

# node는 DR 재프로비저닝 직후 production-release.js·production-backup.js를 바로 돌리는 데 필요하다.
# Ubuntu 24.04의 apt nodejs는 18.x라 이 저장소가 요구하는 24와 맞지 않는다 — NodeSource에서 받는다.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get -o DPkg::Lock::Timeout=300 install -y nodejs
fi

# 일일 백업 타이머 (CLAW-185). 저장소 체크아웃 이후에만 유효하므로 파일이 있을 때만 설치한다.
if [ -f /opt/clawad/deploy/production/systemd/clawad-backup.timer ]; then
  install -m 0644 /opt/clawad/deploy/production/systemd/clawad-backup.service /etc/systemd/system/
  install -m 0644 /opt/clawad/deploy/production/systemd/clawad-backup.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now clawad-backup.timer
fi

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi
