'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  checkoutInfo,
  ensureProjectInfraStopped,
  execute,
} = require('../scripts/alpha-e2e-preflight');

const COMMIT = 'a'.repeat(40);

test('clean checkout의 HEAD commit을 사전검증 manifest에 결속한다', () => {
  const calls = [];
  const manifest = execute({
    checkout: () => COMMIT,
    ensureStopped: () => {},
    runCommand: (args) => calls.push(args.join(' ')),
  });
  assert.equal(manifest.commit, COMMIT);
  assert.equal(manifest.issueKey, 'CLAW-64');
  assert.equal(manifest.platform, process.platform);
  assert.equal(calls.at(-1), 'run infra:down');
});

test('infra:up이 부분 실패해도 정리를 시도하고 원래 실패를 반환한다', () => {
  const calls = [];
  assert.throws(() => execute({
    checkout: () => COMMIT,
    ensureStopped: () => {},
    runCommand: (args) => {
      const command = args.join(' ');
      calls.push(command);
      if (command === 'run infra:up') throw new Error('부분 시작 실패');
    },
  }), /부분 시작 실패/);
  assert.equal(calls.at(-1), 'run infra:down');
});

test('infra:down 실패는 성공 manifest 대신 실패로 처리한다', () => {
  assert.throws(() => execute({
    checkout: () => COMMIT,
    ensureStopped: () => {},
    runCommand: (args) => {
      if (args.join(' ') === 'run infra:down') throw new Error('정리 실패');
    },
  }), /정리 실패/);
});

test('실행 중인 기존 Compose 서비스가 있으면 중단하지 않고 거부한다', () => {
  const spawn = () => ({ status: 0, stdout: 'postgres\nredis\n' });
  assert.throws(() => ensureProjectInfraStopped(spawn), /postgres, redis/);
});

test('dirty checkout은 preflight 전에 거부한다', () => {
  const spawn = () => ({ status: 0, stdout: ' M package.json\n' });
  assert.throws(() => checkoutInfo(spawn), /clean checkout/);
});

test('검증 도중 HEAD가 바뀌면 manifest 생성을 거부한다', () => {
  let readCount = 0;
  assert.throws(() => execute({
    checkout: () => (++readCount === 1 ? COMMIT : 'b'.repeat(40)),
    ensureStopped: () => {},
    runCommand: () => {},
  }), /checkout commit이 변경/);
});
