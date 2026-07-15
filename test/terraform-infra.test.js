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
