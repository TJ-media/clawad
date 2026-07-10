'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const status = spawnSync('git', ['status', '--short'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  windowsHide: true,
});

if (status.status !== 0) process.exit(0);

const changes = status.stdout
  .split(/\r?\n/)
  .map((line) => line.trimEnd())
  .filter(Boolean);

if (changes.length > 0) {
  process.stdout.write(JSON.stringify({
    systemMessage: `커밋되지 않은 변경 ${changes.length}개가 있습니다.\n${changes.join('\n')}`,
  }));
}
