'use strict';
// 서버 내부 멱등 키 생성 (CLAW-18).
// 클라이언트는 HMAC이나 서비스 비밀 키를 보유하지 않는다. 서버가 serveToken을 검증한 뒤
// 토큰의 jti + 머신 + 순번으로 결정적 멱등 키를 만든다.
// 운영 DB는 UNIQUE(token_jti, machine_id, sequence) 제약으로 중복 적립·중복 과금을 막는다.
const crypto = require('crypto');

function idempotencyKey(tokenJti, machineId, sequence) {
  if (!tokenJti || !machineId || !Number.isInteger(sequence)) {
    throw new Error('idempotencyKey: tokenJti, machineId, 정수 sequence가 필요함');
  }
  return crypto.createHash('sha256').update(`${tokenJti}:${machineId}:${sequence}`).digest('hex');
}

module.exports = { idempotencyKey };
