'use strict';
// 기존 statusLine 명령의 파싱과 실행 방식 결정 (CLAW-83).
//
// Windows에서 .cmd·.bat은 명령 해석기 스크립트라 Node 18.20+·20.12+가 shell 없는
// spawn을 EINVAL로 거부하고(CVE-2024-27980), 확장자 없는 이름은 PATHEXT 해석이
// 없어 .cmd shim을 ENOENT로 찾지 못한다. 이 경우에만 cmd.exe /d /s /c 경유로
// 실행한다. shell: true 일괄 적용은 하지 않는다 — parseCommand()의 메타문자
// 거부를 유지한 채, 이미 토큰으로 분해된 명령만 cmd.exe에 넘긴다.
const path = require('path');

function parseCommand(command) {
  if (typeof command !== 'string' || !command.trim() || /[;&|`<>\r\n]|\$\(/.test(command)) return null;
  const parts = [];
  let value = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length && ['"', '\\'].includes(command[i + 1])) value += command[++i];
      else value += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (value) { parts.push(value); value = ''; } }
    else value += ch;
  }
  if (quote) return null;
  if (value) parts.push(value);
  return parts.length ? { executable: parts[0], args: parts.slice(1) } : null;
}

function needsCmdShell(executable, platform) {
  if (platform !== 'win32') return false;
  const ext = path.win32.extname(executable).toLowerCase();
  return ext === '.cmd' || ext === '.bat' || ext === '';
}

// cmd.exe 명령줄용 토큰 인용. 공백·특수문자가 있으면 큰따옴표로 감싸 cmd 메타문자
// (^ 등)를 리터럴로 만든다. 닫는 따옴표 앞 백슬래시는 CRT 파싱 규칙대로 이스케이프.
// %VAR% 확장은 큰따옴표 안에서도 일어난다 — cmd.exe의 고유 동작으로 막지 않는다.
function quoteForCmd(token) {
  if (/^[A-Za-z0-9_\-.:\\/]+$/.test(token)) return token;
  return '"' + token.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

// 실행 인자를 결정한다. cmd.exe 경유 시 verbatim: true — Node의 재인용을 끄고
// (windowsVerbatimArguments) 여기서 만든 명령줄을 그대로 전달해야 한다.
function commandInvocation(command, platform = process.platform, env = process.env) {
  const parsed = parseCommand(command);
  if (!parsed) return null;
  if (!needsCmdShell(parsed.executable, platform)) {
    return { command: parsed.executable, args: parsed.args, verbatim: false };
  }
  const line = [parsed.executable, ...parsed.args].map(quoteForCmd).join(' ');
  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

module.exports = { commandInvocation, parseCommand };
