output "region" {
  description = "고정된 AWS 배포 리전"
  value       = "ap-northeast-2"
}

output "instance_id" {
  description = "생성된 EC2 인스턴스 ID"
  value       = aws_instance.api.id
}

output "public_ip" {
  description = "DNS A 레코드에 연결할 고정 Elastic IP"
  value       = aws_eip.api.public_ip
}

output "api_domain" {
  description = "Terraform이 생성한 Route 53 레코드. 미설정 시 null"
  value       = try(aws_route53_record.api[0].fqdn, null)
}

output "session_manager_command" {
  description = "AWS CLI Session Manager 접속 명령"
  value       = "aws ssm start-session --region ap-northeast-2 --target ${aws_instance.api.id}"
}
