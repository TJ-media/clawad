'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('Terraform은 서울 ARM64 인스턴스와 암호화된 운영 볼륨을 강제한다', () => {
  const versions = read('deploy/terraform/aws/versions.tf');
  const main = read('deploy/terraform/aws/main.tf');

  assert.match(versions, /region\s*=\s*"ap-northeast-2"/);
  assert.match(main, /ubuntu\/server\/24\.04\/stable\/current\/arm64/);
  assert.match(main, /encrypted\s*=\s*true/);
  assert.match(main, /http_tokens\s*=\s*"required"/);
  assert.match(main, /cpu_credits\s*=\s*"standard"/);
  assert.match(main, /disable_api_termination\s*=\s*var\.enable_termination_protection/);
  assert.match(main, /ignore_changes\s*=\s*\[ami\]/);
});

test('Terraform 보안 그룹은 웹만 공개하고 SSH는 명시적 /32 입력에 제한한다', () => {
  const main = read('deploy/terraform/aws/main.tf');
  const variables = read('deploy/terraform/aws/variables.tf');

  assert.match(main, /http\s*=\s*80/);
  assert.match(main, /https\s*=\s*443/);
  assert.match(main, /for_each\s*=\s*var\.ssh_public_key == null/);
  assert.match(variables, /\[0-9\]\{1,3\}.*\/32/);
  assert.doesNotMatch(main, /from_port\s*=\s*5432/);
  assert.doesNotMatch(main, /from_port\s*=\s*6379/);
  assert.doesNotMatch(main, /from_port\s*=\s*3001/);
});

test('Terraform은 시크릿 대신 Session Manager와 고정 IP를 제공한다', () => {
  const main = read('deploy/terraform/aws/main.tf');
  const userData = read('deploy/terraform/aws/user-data.sh');

  assert.match(main, /AmazonSSMManagedInstanceCore/);
  assert.match(main, /resource "aws_eip" "api"/);
  assert.match(userData, /amazon-ssm-agent/);
  assert.match(userData, /fallocate -l 2G \/swapfile/);
  assert.doesNotMatch(userData, /PASSWORD|SECRET|TOKEN/);
  assert.ok(userData.indexOf('amazon-ssm-agent') < userData.indexOf('docker.io'));
});

// SSE-S3는 버킷 접근 권한만 있으면 평문이 그대로 나온다. KMS라야 S3 권한과 복호화 권한이
// 분리되어, 버킷이 실수로 공개돼도 익명 요청이 읽지 못한다 (CLAW-192).
test('백업 버킷은 SSE-KMS로 암호화하고 인스턴스에 KMS 권한을 준다 (CLAW-192)', () => {
  const backup = read('deploy/terraform/aws/s3-backup.tf');

  assert.match(backup, /sse_algorithm\s*=\s*"aws:kms"/);
  assert.doesNotMatch(backup, /sse_algorithm\s*=\s*"AES256"/);
  // 요청 비용을 무료 한도 안에 묶는다. 없으면 객체마다 KMS를 호출한다.
  assert.match(backup, /bucket_key_enabled\s*=\s*true/);

  // KMS 권한이 없으면 SSE-KMS 객체는 올리지도 받지도 못한다.
  assert.match(backup, /kms:GenerateDataKey/);
  assert.match(backup, /kms:Decrypt/);
  // 키 ARN을 고정하지 않는 대신 S3를 거친 호출로 좁힌다.
  assert.match(backup, /kms:ViaService"\s*=\s*"s3\.ap-northeast-2\.amazonaws\.com"/);
});
