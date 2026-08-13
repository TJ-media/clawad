# CLAW-75 운영 백업 외부 복제 저장소.
# EC2/EBS 동반 손실에 대비해 PostgreSQL 백업을 독립된 암호화 S3 버킷으로 복제한다.
# backup_bucket_name이 비어 있으면 백업 리소스를 만들지 않는다(선택적 도입).

variable "backup_bucket_name" {
  description = "백업을 복제할 S3 버킷 이름(전역 고유). 비우면 백업 리소스를 생성하지 않는다."
  type        = string
  default     = ""
}

variable "backup_retention_days" {
  description = "현재 백업 객체 보존 일수. 이후 만료(삭제)된다."
  type        = number
  default     = 90
}

variable "backup_noncurrent_retention_days" {
  description = "버전 관리의 비현재(구버전) 객체 보존 일수."
  type        = number
  default     = 30
}

locals {
  backup_enabled = var.backup_bucket_name != ""
}

resource "aws_s3_bucket" "backup" {
  count  = local.backup_enabled ? 1 : 0
  bucket = var.backup_bucket_name
  tags   = local.common_tags
}

# 퍼블릭 노출 전면 차단.
resource "aws_s3_bucket_public_access_block" "backup" {
  count                   = local.backup_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.backup[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# 버전 관리: 실수 삭제·덮어쓰기로부터 백업을 보호한다.
resource "aws_s3_bucket_versioning" "backup" {
  count  = local.backup_enabled ? 1 : 0
  bucket = aws_s3_bucket.backup[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

# 저장 암호화(SSE-S3/AES256 기본). 고객 관리 키가 필요하면 KMS로 교체하고 스크립트 BACKUP_S3_SSE도 함께 바꾼다.
resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  count  = local.backup_enabled ? 1 : 0
  bucket = aws_s3_bucket.backup[0].id
  rule {
    # SSE-KMS의 AWS 관리 키(aws/s3)를 쓴다 (CLAW-192). kms_master_key_id를 지정하지 않으면 그 키다.
    # SSE-S3(AES256)는 버킷 접근 권한만 있으면 평문이 그대로 나와 사실상 물리 유출만 막는다.
    # KMS는 S3 읽기 권한과 복호화 권한이 분리되어, 버킷이 실수로 공개돼도 익명 요청이 읽지 못한다.
    # 고객 관리 키(CMK)는 복원 권한 분리를 설계할 때 도입한다 — 키 정책이 허용 목록이라
    # "인스턴스는 암호화만, 복호화는 사람 역할만"을 강제할 수 있다(월 $1).
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    # KMS 호출을 객체 단위가 아니라 버킷 단위로 묶어 요청 비용을 줄인다. 무료 한도 안에서 끝난다.
    bucket_key_enabled = true
  }
}

# 보존/삭제 정책: 현재본은 retention_days 후 만료, 구버전은 별도 짧게 만료, 미완료 멀티파트는 정리.
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  count  = local.backup_enabled ? 1 : 0
  bucket = aws_s3_bucket.backup[0].id
  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {}
    expiration {
      days = var.backup_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.backup_noncurrent_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# 전송 암호화 강제: TLS가 아닌 요청을 거부한다.
resource "aws_s3_bucket_policy" "backup" {
  count  = local.backup_enabled ? 1 : 0
  bucket = aws_s3_bucket.backup[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.backup[0].arn,
        "${aws_s3_bucket.backup[0].arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}

# 최소 권한: 인스턴스 역할이 이 버킷에만 List/Put/Get. 삭제는 수명주기에 맡기고 s3:DeleteObject를 부여하지 않는다.
resource "aws_iam_role_policy" "backup" {
  count = local.backup_enabled ? 1 : 0
  name  = "${var.instance_name}-backup-s3"
  role  = aws_iam_role.ssm.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListBackupBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.backup[0].arn]
      },
      {
        Sid      = "ReadWriteBackupObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = ["${aws_s3_bucket.backup[0].arn}/*"]
      },
      # SSE-KMS 객체는 KMS 권한이 없으면 올리지도 받지도 못한다 (CLAW-192).
      # 키 ARN을 고정하지 않고 kms:ViaService로 좁힌다 — AWS 관리 키(aws/s3)는 지연 생성될 수 있고,
      # 나중에 CMK로 올려도 이 정책을 그대로 쓸 수 있다. S3를 거친 호출에만 허용된다.
      #
      # Decrypt를 함께 주는 이유: production-backup.js가 업로드 직후 객체를 다시 내려받아
      # 해시를 대조하고(전송 중 손상 탐지), 복원 드릴도 같은 호스트에서 받는다.
      # 복호화를 사람이 assume하는 역할로 분리하는 것은 CMK 도입 시점의 과제다.
      {
        Sid      = "UseKmsForBackupObjects"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "s3.ap-northeast-2.amazonaws.com"
          }
        }
      },
    ]
  })
}

output "backup_bucket" {
  description = "백업 복제 대상 S3 버킷(미설정 시 null)."
  value       = local.backup_enabled ? aws_s3_bucket.backup[0].bucket : null
}
