'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('Naver code와 client secret은 token URL에 넣지 않는다', () => {
  const source = read('apps/api/src/auth/social/naver.provider.ts');
  assert.doesNotMatch(source, /url\.searchParams\.set\(['"](?:client_secret|code)/);
  assert.match(source, /Content-Type.*application\/x-www-form-urlencoded/);
});

test('운영 OAuth 구성은 공급자별 kill switch와 보존기간을 요구한다', () => {
  const compose = read('deploy/production/compose.yml');
  for (const provider of ['GOOGLE', 'KAKAO', 'NAVER']) {
    assert.match(compose, new RegExp(`SOCIAL_${provider}_ENABLED`));
  }
  assert.match(compose, /SOCIAL_METRICS_RETENTION_DAYS/);
  assert.match(read('docs/operations/oauth-production.md'), /외부 계정/);
});
