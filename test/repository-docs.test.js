'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/^\uFEFF/, '');
}

test('공개 저장소는 소스 열람 전용 비오픈소스 라이선스를 명시한다', () => {
  const licensePath = path.join(ROOT, 'LICENSE');
  assert.strictEqual(fs.existsSync(licensePath), true, '루트 LICENSE가 필요합니다.');

  const license = read('LICENSE');
  assert.match(license, /ClawAd Source Viewing License 1\.0/);
  assert.match(license, /Copyright \(c\) 2026 TJ-media/);
  assert.match(license, /view, inspect, conduct static security review, and evaluate/i);
  assert.match(license, /verbatim, unmodified fork[\s\S]*GitHub/i);
  assert.match(license, /fork functionality[\s\S]*purposes[\s\S]*Section 1\(b\)/i);
  assert.match(license, /must not:[\s\S]*execute, compile, build, install, deploy, host, or otherwise use/i);
  assert.match(license, /must not:[\s\S]*modify, adapt, translate, or create derivative works/i);
  assert.match(license, /must not:[\s\S]*publish, distribute, transmit, sublicense, sell/i);
  assert.match(license, /must not:[\s\S]*commercial purpose/i);
  assert.match(license, /must not:[\s\S]*competes with or substitutes for ClawAd/i);
  assert.match(license, /separate written permission/i);
  assert.match(license, /separate written agreement controls/i);
  assert.match(license, /not an open source license/i);
});

test('README는 알파 단계·설치 권한·라이선스 범위를 정확히 안내한다', () => {
  const readme = read('README.md');

  assert.match(readme, /알파 테스트 단계/);
  assert.doesNotMatch(readme, /폐쇄형 알파/);
  assert.match(readme, /Node\.js 24 이상/);
  const version = JSON.parse(read('package.json')).version;
  // 설치 진입점은 latest여야 알파 테스터가 구버전에 묶이지 않는다. 버전 고정은 재현이 필요한 경우의 예외다.
  const latest = 'https://github.com/TJ-media/clawad/releases/latest/download/clawad-cli.tgz';
  assert.ok(readme.includes(`npx --yes ${latest} setup`), '알파 설치 안내는 최신 릴리스 URL이어야 합니다.');
  assert.ok(readme.includes(`npx.cmd --yes ${latest} setup`), 'Windows 설치 안내는 최신 릴리스 URL이어야 합니다.');
  for (const match of readme.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)\//g)) {
    assert.strictEqual(match[1], version, 'README에 남은 버전 고정 URL이 package.json과 달라졌습니다.');
  }
  assert.doesNotMatch(readme, /<설치 패키지 URL>/, '설치 안내에 자리표시자가 남아 있으면 안 됩니다.');
  assert.doesNotMatch(readme, /<provider>/, '설치 안내에 그대로 실행할 수 없는 자리표시자를 두지 않는다.');
  // 공급자 선택·약관 동의는 웹 로그인 화면이 처리한다(CLAW-100). 설치 명령에 인자를 붙이지 않는다.
  assert.doesNotMatch(readme, /--accept-terms/, '약관 동의는 브라우저 로그인 화면에서 받는다.');
  assert.doesNotMatch(readme, /setup google/, '설치 명령에 공급자 인자를 남기지 않는다.');
  assert.match(readme, /로그인 수단 선택과 약관 동의는 모두 이 화면에서 진행합니다/, '브라우저 로그인 흐름을 안내해야 합니다.');
  assert.match(readme, /설치 중 문제가 생겼다면/, 'README에 설치 트러블슈팅 안내가 필요합니다.');
  assert.match(readme, /관리자 권한이 필요할 수 있습니다/, 'Windows 관리자 권한 필요 가능성을 준비물에 고지해야 합니다.');

  const distribution = read('docs/operations/client-distribution.md');
  for (const match of distribution.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)\//g)) {
    assert.strictEqual(match[1], version, '배포 문서의 릴리스 URL 버전이 package.json과 달라졌습니다.');
  }
  assert.match(readme, /별도 서면 허가/);
  assert.match(readme, /오픈소스가 아닙니다/);
  assert.match(readme, /\[ClawAd Source Viewing License 1\.0\]\(LICENSE\)/);
  assert.match(readme, /Anthropic.*Claude.*제휴.*후원 관계가 없는/);
  assert.match(readme, /비공개 자료나 원본 코드를 열람·인용·복제하지 않고/);
});
