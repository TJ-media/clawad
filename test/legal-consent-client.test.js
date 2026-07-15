'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'login.js'), 'utf8');

test('CLI는 서버의 활성 문서 버전으로 약관·개인정보 동의를 각각 전송한다', () => {
  assert.match(source, /\/v1\/legal\/documents/);
  assert.match(source, /--accept-terms/);
  assert.match(source, /--accept-privacy/);
  assert.match(source, /new Map\(latest\.documents/);
  assert.match(source, /documentVersion: versions\.get\(type\)/);
  assert.match(source, /documentVersions\(latest\) !== documentVersions\(bundle\)/);
  assert.doesNotMatch(source, /--accept-terms=/);
});

test('CLI는 가입 전에 문서·광고/리워드/개인정보 고지와 거부 후 안내를 표시한다', () => {
  assert.match(source, /showLegalDocuments\(documents\)/);
  assert.match(source, /bundle\.disclosures/);
  assert.match(source, /removalGuideUrl/);
  assert.match(source, /privacyContactUrl/);
});
