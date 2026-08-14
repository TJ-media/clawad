'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_RELEASE_BYTES = 50 * 1024 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function secureUrl(value, label) {
  let url;
  try { url = new URL(value); } catch {}
  const allowHttp = process.env.CLAWAD_ALLOW_INSECURE_RELEASE === '1';
  if (!url || (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) || url.username || url.password) {
    throw new Error(`${label}은 자격증명 없는 HTTPS URL이어야 합니다.`);
  }
  return url;
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || !VERSION_PATTERN.test(value.version || '')) {
    throw new Error('릴리스 manifest의 version이 올바르지 않습니다.');
  }
  secureUrl(value.packageUrl, 'packageUrl');
  if (!SHA256_PATTERN.test(value.sha256 || '')) throw new Error('릴리스 manifest의 SHA-256이 올바르지 않습니다.');
  return { version: value.version, packageUrl: value.packageUrl, sha256: value.sha256 };
}

// onProgress(받은 바이트, 전체 바이트 또는 0)를 주면 본문을 스트리밍으로 읽어 진행을 알린다.
// 오버레이는 100MB가 넘어서, 한 번의 await로 받으면 터미널이 몇 분간 멈춘 것처럼 보인다.
// 스트리밍 경로는 상한도 받는 중에 검사한다 — content-length가 없으면 다 받은 뒤 검사하는
// 기존 방식으로는 메모리를 먼저 다 쓰게 된다.
async function download(url, maxBytes = MAX_RELEASE_BYTES, onProgress) {
  const response = await fetch(secureUrl(url, '릴리스 URL'));
  if (!response.ok) throw new Error(`릴리스 다운로드 실패 (HTTP ${response.status})`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error('릴리스 파일이 허용 크기를 초과했습니다.');
  if (typeof onProgress !== 'function' || !response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('릴리스 파일이 허용 크기를 초과했습니다.');
    return bytes;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maxBytes) throw new Error('릴리스 파일이 허용 크기를 초과했습니다.');
    chunks.push(chunk);
    onProgress(received, length);
  }
  return Buffer.concat(chunks);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Windows에서 npm.cmd를 shell 없이 spawn하면 EINVAL로 거부된다(Node 18.20+·20.12+, CVE-2024-27980 대응).
// npm-cli.js를 현재 node로 직접 실행해 우회한다. npm_execpath는 npm-cli.js일 때만 신뢰한다
// (yarn·pnpm으로 실행된 경우 인자 해석이 달라 오동작한다).
function npmInvocation(args, platform = process.platform, execPath = process.execPath) {
  if (platform !== 'win32') return { command: 'npm', args: [...args] };
  const execpath = process.env.npm_execpath;
  if (execpath && path.basename(execpath) === 'npm-cli.js') return { command: execPath, args: [execpath, ...args] };
  const bundled = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(bundled)) {
    throw new Error('npm(npm-cli.js)을 찾을 수 없습니다. Node.js와 함께 설치된 npm이 필요합니다.');
  }
  return { command: execPath, args: [bundled, ...args] };
}

module.exports = { MAX_RELEASE_BYTES, download, npmInvocation, secureUrl, sha256, validateManifest };
