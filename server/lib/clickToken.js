'use strict';
// 클릭 URL 전용 서명 토큰(CLAW-49). serveToken·인증 토큰과 분리한다.
const crypto = require('crypto');

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function issueClickToken(claims, secret, ttlMs, now = Date.now()) {
  if (!claims || !validUrl(claims.landingUrl)) throw new TypeError('INVALID_LANDING_URL');
  const payload = {
    jti: crypto.randomUUID(),
    campaignId: claims.campaignId,
    creativeId: claims.creativeId,
    userId: claims.userId,
    machineId: claims.machineId,
    landingUrl: claims.landingUrl,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

function verifyClickToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.split('.').length !== 2) return { ok: false, reason: 'BAD_TOKEN' };
  const [payloadB64, signature] = token.split('.');
  if (!safeEqual(signature, sign(payloadB64, secret))) return { ok: false, reason: 'BAD_TOKEN' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'BAD_TOKEN' };
  }
  if (!payload || typeof payload.jti !== 'string' || typeof payload.campaignId !== 'string' ||
      typeof payload.creativeId !== 'string' || typeof payload.userId !== 'string' ||
      typeof payload.machineId !== 'string' || !validUrl(payload.landingUrl) ||
      typeof payload.issuedAt !== 'number' || typeof payload.expiresAt !== 'number') {
    return { ok: false, reason: 'BAD_TOKEN' };
  }
  if (now > payload.expiresAt) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, payload };
}

module.exports = { issueClickToken, verifyClickToken, validUrl };
