#!/usr/bin/env node
'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const containerName = `clawad-redis-persistence-test-${suffix}`;
const volumeName = `clawad-redis-persistence-test-${suffix}`;
const key = `clawad:persistence:test:${randomUUID()}`;
const value = randomBytes(24).toString('hex');

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'ignore',
  });
  if (result.error || result.status !== 0) {
    throw new Error(options.message || 'Docker 명령 실행에 실패했습니다.');
  }
  return options.capture ? result.stdout.trim() : '';
}

function startRedis() {
  docker([
    'run',
    '-d',
    '--name',
    containerName,
    '-v',
    `${volumeName}:/data`,
    'redis:7-alpine',
    'redis-server',
    '--appendonly',
    'yes',
    '--appendfsync',
    'always',
  ]);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync('docker', ['exec', containerName, 'redis-cli', 'ping'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.status === 0 && result.stdout.trim() === 'PONG') return;
  }
  throw new Error('격리 Redis가 준비되지 않았습니다.');
}

function removeContainer() {
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
}

try {
  docker(['volume', 'create', volumeName]);
  startRedis();
  docker(['exec', containerName, 'redis-cli', 'SET', key, value, 'EX', '120']);

  removeContainer();
  startRedis();
  const restored = docker(
    ['exec', containerName, 'redis-cli', '--raw', 'GET', key],
    { capture: true },
  );
  if (restored !== value) throw new Error('재시작 후 TTL 키가 복원되지 않았습니다.');

  const ttl = Number(docker(
    ['exec', containerName, 'redis-cli', '--raw', 'TTL', key],
    { capture: true },
  ));
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 120) {
    throw new Error('재시작 후 TTL이 보존되지 않았습니다.');
  }

  docker(['exec', containerName, 'redis-cli', 'DEL', key]);
  removeContainer();
  startRedis();
  const deleted = docker(
    ['exec', containerName, 'redis-cli', '--raw', 'GET', key],
    { capture: true },
  );
  if (deleted !== '') throw new Error('삭제한 키가 재시작 후 되살아났습니다.');

  console.log('Redis AOF 영속성 검증 통과: TTL 유지 및 삭제 비복원');
} finally {
  removeContainer();
  spawnSync('docker', ['volume', 'rm', '-f', volumeName], { stdio: 'ignore' });
}
