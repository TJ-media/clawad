'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const composePath = path.join(__dirname, '..', 'docker-compose.yml');

test('Redis는 AOF always와 이름 볼륨으로 세션을 영속화한다', () => {
  const compose = fs.readFileSync(composePath, 'utf8').replace(/^\uFEFF/, '');

  assert.match(
    compose,
    /command:\s*\['redis-server', '--appendonly', 'yes', '--appendfsync', 'always'\]/,
  );
  assert.match(compose, /- clawad-redisdata:\/data/);
  assert.match(compose, /volumes:\s*\r?\n\s+clawad-pgdata:\s*\r?\n\s+clawad-redisdata:/);
});
