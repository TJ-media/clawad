'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'login.js'), 'utf8');

test('CLI는 서버의 활성 문서 버전으로 약관·개인정보 동의를 각각 전송한다', () => {
  assert.match(source, /\/v1\/legal\/documents/);
  assert.match(source, /new Map\(latest\.documents/);
  assert.match(source, /documentVersion: versions\.get\(type\)/);
  assert.match(source, /documentVersions\(latest\) !== documentVersions\(bundle\)/);
});

test('CLI는 공급자 선택·약관 동의를 웹 로그인 페이지에 위임한다 (CLAW-100)', () => {
  // 공급자 선택과 동의 수집은 웹이 한다. CLI가 authorization 시작을 직접 호출하면 안 된다.
  assert.match(source, /cli_return/);
  assert.doesNotMatch(source, /\/start/, 'CLI는 소셜 authorization 시작을 직접 호출하지 않는다.');
  assert.doesNotMatch(source, /ALLOWED_PROVIDERS/, '공급자 인자는 더 이상 CLI가 받지 않는다.');
  // 동의 결과는 loopback 쿼리의 문서 버전으로만 인정한다. 플래그로 동의를 대신할 수 없다.
  assert.match(source, /CONSENT_PARAM/);
  assert.match(source, /accepted\.get\(type\) !== versions\.get\(type\)/);
  // 브라우저를 닫거나 동의를 취소해도 무기한 대기하지 않는다.
  assert.match(source, /LOGIN_TIMEOUT_MS/);
});

test('CLI loopback은 handoff code만 받고 토큰은 브라우저를 거치지 않는다', () => {
  assert.doesNotMatch(source, /searchParams\.get\('(access|refresh)/i);
  assert.match(source, /searchParams\.get\('code'\)/);
  assert.match(source, /\/v1\/auth\/social\/exchange/);
});

test('CLI는 가입 전에 문서·광고/리워드/개인정보 고지와 거부 후 안내를 표시한다', () => {
  assert.match(source, /showLegalDocuments\(documents\)/);
  assert.match(source, /bundle\.disclosures/);
  assert.match(source, /removalGuideUrl/);
  assert.match(source, /privacyContactUrl/);
});
