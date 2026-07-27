#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const command = process.argv[2];
const args = process.argv.slice(3);
const scripts = {
  install: ['install.js', 'install'],
  uninstall: ['install.js', 'uninstall'],
  pause: ['install.js', 'pause'],
  resume: ['install.js', 'resume'],
  status: ['install.js', 'status'],
  login: ['login.js'],
  update: ['update.js'],
  // 오버레이(clawad-overlay)가 표시 사실을 스풀에 남긴 뒤 즉시 트리거하는 커맨드 (CLAW-90).
  'collect-overlay-events': ['overlay-events.js', 'collect'],
};

function run(script, scriptArgs) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...scriptArgs], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

if (command === 'setup') {
  process.exitCode = run('setup.js', args);
} else if (scripts[command]) {
  const [script, ...prefix] = scripts[command];
  process.exitCode = run(script, [...prefix, ...args]);
} else {
  console.error('사용법: clawad <setup|install|login|update|pause|resume|status|uninstall|collect-overlay-events>');
  process.exitCode = 1;
}
