'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { commandInvocation, parseCommand } = require('../client/statusline-command');

test('win32에서 .cmd·.bat 명령은 cmd.exe /d /s /c 경유로 실행한다', () => {
  for (const command of ['ccusage.cmd statusline', 'C:\\tools\\bar.BAT --flag']) {
    const invocation = commandInvocation(command, 'win32', {});
    assert.strictEqual(invocation.command, 'cmd.exe');
    assert.deepStrictEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.strictEqual(invocation.verbatim, true);
  }
});

test('win32에서 확장자 없는 명령 이름도 cmd.exe 경유로 PATHEXT 해석을 받는다', () => {
  const invocation = commandInvocation('ccusage statusline', 'win32', {});
  assert.strictEqual(invocation.command, 'cmd.exe');
  assert.strictEqual(invocation.args[3], '"ccusage statusline"');
});

test('win32라도 .exe·.js 확장자는 기존처럼 직접 spawn한다', () => {
  for (const command of ['C:\\node\\node.exe script.js', 'tool.js --a']) {
    const invocation = commandInvocation(command, 'win32', {});
    assert.strictEqual(invocation.verbatim, false);
    assert.notStrictEqual(invocation.command, 'cmd.exe');
  }
});

test('win32가 아니면 항상 직접 spawn한다', () => {
  const invocation = commandInvocation('ccusage statusline', 'linux', {});
  assert.deepStrictEqual(invocation, { command: 'ccusage', args: ['statusline'], verbatim: false });
});

test('공백 경로와 인자는 cmd.exe 명령줄에서 큰따옴표로 인용된다', () => {
  const invocation = commandInvocation('"C:\\Program Files\\tool\\run.cmd" "my arg"', 'win32', {});
  assert.strictEqual(invocation.args[3], '""C:\\Program Files\\tool\\run.cmd" "my arg""');
});

test('ComSpec이 있으면 그 경로의 cmd를 사용한다', () => {
  const invocation = commandInvocation('foo.cmd', 'win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' });
  assert.strictEqual(invocation.command, 'C:\\WINDOWS\\system32\\cmd.exe');
});

test('셸 메타문자 명령은 플랫폼과 무관하게 계속 거부한다 (주입 방어 회귀)', () => {
  for (const command of ['node bad.js; echo x', 'a.cmd | more', 'a.cmd & b', 'a.cmd > out', 'a.cmd `x`', 'a.cmd $(x)', 'a.cmd <in', 'a.cmd \nb']) {
    assert.strictEqual(commandInvocation(command, 'win32', {}), null, command);
    assert.strictEqual(parseCommand(command), null, command);
  }
});

test('캐럿·퍼센트 인자는 인용돼 cmd 이스케이프로 재해석되지 않는다', () => {
  const invocation = commandInvocation('foo.cmd a^b', 'win32', {});
  assert.strictEqual(invocation.args[3], '"foo.cmd "a^b""');
});
