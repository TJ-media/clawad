mock_provider "aws" {}

override_data {
  target = data.aws_ssm_parameter.ubuntu_2404_arm64_ami
  values = {
    value = "ami-0123456789abcdef0"
  }
}

override_data {
  target = data.aws_vpc.default
  values = {
    id = "vpc-0123456789abcdef0"
  }
}

override_data {
  target = data.aws_subnets.default
  values = {
    ids = ["subnet-0123456789abcdef0"]
  }
}

override_data {
  target = data.aws_subnet.selected
  values = {
    id     = "subnet-0123456789abcdef0"
    vpc_id = "vpc-0123456789abcdef0"
  }
}

run "default_seoul_instance" {
  command = plan

  assert {
    condition     = aws_instance.api.instance_type == "t4g.small"
    error_message = "기본 인스턴스 유형은 t4g.small이어야 합니다."
  }

  assert {
    condition     = aws_instance.api.root_block_device[0].encrypted
    error_message = "루트 EBS 암호화가 활성화되어야 합니다."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.ssh) == 0
    error_message = "기본 구성에서는 SSH를 공개하지 않아야 합니다."
  }
}
