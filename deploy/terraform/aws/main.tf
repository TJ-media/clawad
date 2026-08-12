data "aws_ssm_parameter" "ubuntu_2404_arm64_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

locals {
  subnet_id = coalesce(var.subnet_id, sort(data.aws_subnets.default.ids)[0])
  common_tags = {
    Service = "api"
  }
}

data "aws_subnet" "selected" {
  id = local.subnet_id
}

resource "aws_iam_role" "ssm" {
  name = "${var.instance_name}-ssm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ssm" {
  name = "${var.instance_name}-ssm-profile"
  role = aws_iam_role.ssm.name
}

resource "aws_key_pair" "ssh" {
  count = var.ssh_public_key == null ? 0 : 1

  key_name   = "${var.instance_name}-ssh"
  public_key = var.ssh_public_key

  tags = local.common_tags
}

resource "aws_security_group" "instance" {
  name_prefix = "${var.instance_name}-"
  description = "Clawad production API ingress"
  vpc_id      = data.aws_subnet.selected.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.instance_name}-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = {
    http  = 80
    https = 443
  }

  security_group_id = aws_security_group.instance.id
  description       = upper(each.key)
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = var.ssh_public_key == null ? toset([]) : var.allowed_ssh_cidrs

  security_group_id = aws_security_group.instance.id
  description       = "Administrator SSH"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_egress_rule" "all_ipv4" {
  security_group_id = aws_security_group.instance.id
  description       = "Outbound for packages, OAuth and alerts"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "api" {
  ami                         = data.aws_ssm_parameter.ubuntu_2404_arm64_ami.value
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.instance.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.ssm.name
  key_name                    = var.ssh_public_key == null ? null : aws_key_pair.ssh[0].key_name

  disable_api_termination = var.enable_termination_protection
  ebs_optimized           = true
  monitoring              = false

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    encrypted             = true
    delete_on_termination = true
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gib
    iops                  = 3000
    throughput            = 125
    tags = merge(local.common_tags, {
      Name = "${var.instance_name}-root"
    })
  }

  user_data                   = replace(file("${path.module}/user-data.sh"), "\r\n", "\n")
  user_data_replace_on_change = false

  tags = merge(local.common_tags, {
    Name = var.instance_name
  })

  lifecycle {
    # Canonical의 current AMI 갱신만으로 운영 DB가 있는 인스턴스를 교체하지 않는다.
    # AMI 교체는 백업·복구 검증 뒤 명시적인 유지보수 작업으로 수행한다.
    ignore_changes = [ami]

    precondition {
      condition     = length(var.allowed_ssh_cidrs) == 0 || var.ssh_public_key != null
      error_message = "allowed_ssh_cidrs를 설정하려면 ssh_public_key도 함께 입력해야 합니다."
    }
  }

  depends_on = [aws_iam_role_policy_attachment.ssm_core]
}

resource "aws_eip" "api" {
  domain   = "vpc"
  instance = aws_instance.api.id

  tags = merge(local.common_tags, {
    Name = "${var.instance_name}-eip"
  })
}

resource "aws_route53_record" "api" {
  count = var.route53_record == null ? 0 : 1

  zone_id = var.route53_record.zone_id
  name    = var.route53_record.name
  type    = "A"
  ttl     = 300
  records = [aws_eip.api.public_ip]
}

# 호스트가 죽으면 호스트 안의 어떤 컴포넌트도 그 사실을 알릴 수 없다 (CLAW-179).
# 상태 검사는 상세 모니터링과 무관하게 1분 주기로 게시되므로 monitoring=false여도 동작한다.
resource "aws_cloudwatch_metric_alarm" "instance_status_check" {
  alarm_name          = "${var.instance_name}-status-check-failed"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  # 지표가 끊긴 것도 장애다. 무응답을 정상으로 읽지 않는다.
  treat_missing_data = "breaching"

  dimensions = {
    InstanceId = aws_instance.api.id
  }

  alarm_description = "EC2 인스턴스·시스템 상태 검사 실패. 호스트 안의 알림 스택이 함께 죽었을 수 있습니다."
  alarm_actions     = var.alarm_sns_topic_arn == null ? [] : [var.alarm_sns_topic_arn]
  ok_actions        = var.alarm_sns_topic_arn == null ? [] : [var.alarm_sns_topic_arn]

  tags = merge(local.common_tags, {
    Name = "${var.instance_name}-status-check-failed"
  })
}
