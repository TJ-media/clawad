variable "instance_name" {
  description = "EC2 Name 태그와 관련 리소스 이름의 접두사"
  type        = string
  default     = "clawad-prod"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.instance_name))
    error_message = "instance_name은 3~32자의 소문자, 숫자, 하이픈만 사용할 수 있습니다."
  }
}

variable "instance_type" {
  description = "ARM64 Graviton 인스턴스 유형"
  type        = string
  default     = "t4g.small"

  validation {
    condition     = contains(["t4g.small", "t4g.medium"], var.instance_type)
    error_message = "검증된 인스턴스 유형은 t4g.small 또는 t4g.medium입니다."
  }
}

variable "root_volume_size_gib" {
  description = "암호화된 gp3 루트 볼륨 크기"
  type        = number
  default     = 30

  validation {
    condition     = var.root_volume_size_gib >= 30 && var.root_volume_size_gib <= 100
    error_message = "루트 볼륨은 30~100GiB 사이여야 합니다."
  }
}

variable "enable_termination_protection" {
  description = "실수로 인스턴스를 종료하지 못하도록 API 종료 방지를 활성화합니다."
  type        = bool
  default     = true
}

variable "subnet_id" {
  description = "지정하지 않으면 서울 리전 기본 VPC의 기본 서브넷 하나를 사용합니다."
  type        = string
  default     = null
  nullable    = true
}

variable "ssh_public_key" {
  description = "선택 사항. SSH를 사용할 때 등록할 OpenSSH 공개키이며 개인키는 절대 입력하지 않습니다."
  type        = string
  default     = null
  nullable    = true
}

variable "allowed_ssh_cidrs" {
  description = "선택 사항. SSH 22번을 허용할 /32 CIDR 목록. 기본값은 SSH 비공개입니다."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.allowed_ssh_cidrs : can(cidrhost(cidr, 0)) && can(regex("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/32$", cidr))
    ])
    error_message = "SSH 소스는 각 장소의 단일 공인 IPv4 주소(/32)만 허용합니다."
  }
}

variable "route53_record" {
  description = "선택 사항. Route 53에서 관리하는 API 도메인의 Zone ID와 FQDN"
  type = object({
    zone_id = string
    name    = string
  })
  default  = null
  nullable = true
}
