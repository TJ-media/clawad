'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('운영 compose는 DB·Redis를 비공개 영속 서비스로 구성한다', () => {
  const compose = read('deploy/production/compose.yml');
  assert.match(compose, /postgres-data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /redis-data:\/data/);
  assert.match(compose, /--appendfsync always/);
  assert.match(compose, /--requirepass/);
  assert.match(compose, /backend:\s*\n\s*internal: true/);
  assert.doesNotMatch(compose, /postgres:\s*\n(?: {4}.*\n)* {4}ports:/);
  assert.doesNotMatch(compose, /redis:\s*\n(?: {4}.*\n)* {4}ports:/);
});

test('운영 경계는 HTTPS, 준비 상태와 격리 복구를 제공한다', () => {
  const compose = read('deploy/production/compose.yml');
  assert.match(compose, /'443:443'/);
  assert.match(compose, /health\/ready/);
  assert.match(compose, /postgres-restore:[\s\S]*?tmpfs:/);
  assert.match(read('deploy/production/Caddyfile'), /reverse_proxy api:3000/);
  assert.match(read('docs/operations/production-deployment.md'), /down -v/);
});

test('운영 API 이미지는 비루트 사용자와 production 실행을 사용한다', () => {
  const dockerfile = read('apps/api/Dockerfile');
  assert.match(dockerfile, /FROM node:24-alpine/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /NODE_ENV=production/);
  assert.match(dockerfile, /apps\/api\/node_modules/);
  assert.match(dockerfile, /server\/lib/);
});
