'use strict';
// serveToken 발급·검증 (CLAW-18/4).
// 서버만 비밀 키를 보유한다. 클라이언트는 토큰을 보관·제출만 하며 서명을 만들지 못한다.
// 토큰에는 jti, campaignId, creativeId, userId, machineId, issuedAt, expiresAt를 담는다.
// 수명은 정책값(serveToken.ttlMs, 기본 10분)으로 관리한다.
const crypto = require('crypto');

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function validSnapshot(s) {
  return s && Number.isInteger(s.policyVersion) && s.policyVersion > 0 &&
    (s.rewardPolicyId === null || typeof s.rewardPolicyId === 'string') &&
    typeof s.billingEligible === 'boolean' && typeof s.rewardEligible === 'boolean' &&
    Number.isInteger(s.pricePerImpressionKrw) && s.pricePerImpressionKrw >= 0 &&
    Number.isInteger(s.rewardPerThousandAcceptedImpressions) && s.rewardPerThousandAcceptedImpressions > 0 &&
    Number.isInteger(s.minViewMs) && s.minViewMs > 0 &&
    Number.isInteger(s.concurrentToleranceMs) && s.concurrentToleranceMs >= 0 &&
    Number.isInteger(s.timeWindowToleranceMs) && s.timeWindowToleranceMs >= 0 &&
    Number.isInteger(s.dailyAcceptedImpressionLimit) && s.dailyAcceptedImpressionLimit > 0 &&
    Number.isInteger(s.dailyRewardLimit) && s.dailyRewardLimit > 0 &&
    Number.isInteger(s.perCampaignDailyImpressionLimit) && s.perCampaignDailyImpressionLimit > 0 &&
    (s.advertiserDailyImpressionLimit === null ||
      (Number.isInteger(s.advertiserDailyImpressionLimit) && s.advertiserDailyImpressionLimit > 0));
}

// claims: { campaignId, creativeId, userId, machineId, campaignType, policySnapshotId, policySnapshot }
function issueServeToken(claims, secret, ttlMs, now = Date.now()) {
  if (typeof claims.policySnapshotId !== 'string' || !validSnapshot(claims.policySnapshot)) {
    throw new TypeError('INVALID_POLICY_SNAPSHOT');
  }
  const payload = {
    jti: crypto.randomUUID(),
    campaignId: claims.campaignId,
    creativeId: claims.creativeId,
    userId: claims.userId,
    machineId: claims.machineId,
    campaignType: claims.campaignType,
    policySnapshotId: claims.policySnapshotId,
    policySnapshot: claims.policySnapshot,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

// 반환: { ok, payload } 또는 { ok:false, reason }
function verifyServeToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'BAD_TOKEN' };
  const [payloadB64, sig] = token.split('.');
  const expected = sign(payloadB64, secret);
  // 타이밍 안전 비교
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_TOKEN' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'BAD_TOKEN' };
  }
  if (
    typeof payload.jti !== 'string' ||
    typeof payload.campaignId !== 'string' ||
    typeof payload.creativeId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.machineId !== 'string' ||
    typeof payload.campaignType !== 'string' ||
    typeof payload.issuedAt !== 'number' ||
    typeof payload.policySnapshotId !== 'string' ||
    !validSnapshot(payload.policySnapshot)
  ) {
    return { ok: false, reason: 'BAD_TOKEN' };
  }
  if (typeof payload.expiresAt !== 'number' || now > payload.expiresAt) {
    return { ok: false, reason: 'EXPIRED' };
  }
  return { ok: true, payload };
}

module.exports = { issueServeToken, verifyServeToken, validSnapshot };
