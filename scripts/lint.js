#!/usr/bin/env node
'use strict';
// 저장소의 모든 .js 파일에 node --check(구문 검사)를 실행한다.
// TypeScript가 없으므로 typecheck도 동일한 구문 검사로 대체한다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'data', '.git']);

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

let failed = 0;
for (const file of walk(ROOT)) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`구문 오류: ${path.relative(ROOT, file)}`);
    console.error(String(e.stderr || e.message));
  }
}
if (failed) {
  console.error(`lint 실패: ${failed}개 파일`);
  process.exit(1);
}
console.log('lint 통과');
