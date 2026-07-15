'use strict';

const crypto = require('crypto');

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

async function download(url, maxBytes = MAX_RELEASE_BYTES) {
  const response = await fetch(secureUrl(url, '릴리스 URL'));
  if (!response.ok) throw new Error(`릴리스 다운로드 실패 (HTTP ${response.status})`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error('릴리스 파일이 허용 크기를 초과했습니다.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('릴리스 파일이 허용 크기를 초과했습니다.');
  return bytes;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

module.exports = { MAX_RELEASE_BYTES, download, secureUrl, sha256, validateManifest };
