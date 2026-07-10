'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JS_EXTENSION = /\.(?:cjs|mjs|js)$/i;

function readPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractPaths(payload) {
  const result = new Set();
  const toolInput = payload && payload.tool_input;
  const command = toolInput && typeof toolInput.command === 'string'
    ? toolInput.command
    : '';

  for (const line of command.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update) File:\s+(.+?)\s*$/)
      || line.match(/^\*\*\* Move to:\s+(.+?)\s*$/);
    if (match) result.add(match[1]);
  }

  if (toolInput && typeof toolInput.file_path === 'string') {
    result.add(toolInput.file_path);
  }

  return [...result];
}

function resolveRepoFile(filePath) {
  const absolutePath = path.resolve(REPO_ROOT, filePath);
  const relativePath = path.relative(REPO_ROOT, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return absolutePath;
}

const payload = readPayload();
if (!payload) process.exit(0);

const failures = [];
for (const candidate of extractPaths(payload)) {
  const absolutePath = resolveRepoFile(candidate);
  if (!absolutePath || !JS_EXTENSION.test(absolutePath) || !fs.existsSync(absolutePath)) {
    continue;
  }

  const check = spawnSync(process.execPath, ['--check', absolutePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (check.status !== 0) {
    const detail = (check.stderr || check.stdout || '알 수 없는 구문 오류').trim();
    failures.push(`${path.relative(REPO_ROOT, absolutePath)}\n${detail}`);
  }
}

if (failures.length > 0) {
  process.stdout.write(JSON.stringify({
    systemMessage: `변경된 JavaScript에 구문 오류가 있습니다.\n${failures.join('\n\n')}`,
  }));
}
