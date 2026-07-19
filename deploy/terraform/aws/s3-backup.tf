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
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
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
    ]
  })
}

output "backup_bucket" {
  description = "백업 복제 대상 S3 버킷(미설정 시 null)."
  value       = local.backup_enabled ? aws_s3_bucket.backup[0].bucket : null
}
