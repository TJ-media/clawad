'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { npmInvocation } = require('../client/release');

// Windows 기본 설치 배치(node.exe 옆 node_modules/npm)를 흉내낸 가짜 실행 경로.
function fakeNodeWithNpm() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawad-npm-'));
  const bin = path.join(dir, 'node_modules', 'npm', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm-cli.js'), '');
  return { execPath: path.join(dir, 'node.exe'), cli: path.join(bin, 'npm-cli.js') };
}

function withExecpath(value, fn) {
  const original = process.env.npm_execpath;
  if (value === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
  }
}

test('win32가 아니면 npm을 그대로 실행한다', () => {
  const invocation = npmInvocation(['install', '--prefix', '/tmp/x'], 'linux');
  assert.strictEqual(invocation.command, 'npm');
  assert.deepStrictEqual(invocation.args, ['install', '--prefix', '/tmp/x']);
});

test('win32에서는 npm.cmd 대신 npm-cli.js를 node로 실행한다', () => {
  // .cmd 직접 실행은 Node 18.20+·20.12+에서 EINVAL로 거부된다.
  const { execPath, cli } = fakeNodeWithNpm();
  withExecpath(undefined, () => {
    const invocation = npmInvocation(['pack'], 'win32', execPath);
    assert.strictEqual(invocation.command, execPath);
    assert.deepStrictEqual(invocation.args, [cli, 'pack']);
  });
});

test('win32에서 npm_execpath는 npm-cli.js일 때만 신뢰한다', () => {
  const { execPath, cli } = fakeNodeWithNpm();
  const trusted = path.join('C:', 'npm', 'bin', 'npm-cli.js');
  withExecpath(trusted, () => {
    assert.strictEqual(npmInvocation(['pack'], 'win32', execPath).args[0], trusted);
  });
  // yarn·pnpm으로 실행되면 인자 해석이 달라 오동작하므로 무시하고 번들 npm을 쓴다.
  for (const other of [path.join('C:', 'y', 'yarn.js'), path.join('C:', 'p', 'pnpm.cjs'), path.join('C:', 'n', 'npm.cmd')]) {
    withExecpath(other, () => {
      assert.strictEqual(npmInvocation(['pack'], 'win32', execPath).args[0], cli);
    });
  }
});

test('win32에서 npm을 찾지 못하면 원인을 알 수 있는 오류를 낸다', () => {
  const missing = path.join(os.tmpdir(), 'clawad-no-npm', 'node.exe');
  withExecpath(undefined, () => {
    assert.throws(() => npmInvocation(['install'], 'win32', missing), /npm-cli\.js.*찾을 수 없습니다/);
  });
});

test('인자 배열을 변형하지 않는다', () => {
  const args = ['install'];
  const { execPath } = fakeNodeWithNpm();
  withExecpath(undefined, () => npmInvocation(args, 'win32', execPath));
  npmInvocation(args, 'linux');
  assert.deepStrictEqual(args, ['install']);
});
