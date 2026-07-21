'use strict';
// 기기 등록 제한 (CLAW-1 정책): 한 사용자 계정에 최대 N대(정책값, 기본 3대).
// 네 번째 기기는 등록 불가. 새 기기를 등록하려면 기존 기기를 먼저 해제해야 한다.
// 여러 기기에서 사용하는 것 자체는 허용한다.
//
// 이 함수는 판정 규칙만 담당한다. 운영 서버는 등록 검사를 DB 트랜잭션 안에서 수행해
// 동시 요청으로 상한을 초과하지 못하게 한다(행 잠금 또는 조건부 INSERT/COUNT).

// 반환: { ok:true } 또는 { ok:false, status, code }
function canRegisterDevice(activeDeviceCount, maxDevicesPerAccount) {
  if (activeDeviceCount >= maxDevicesPerAccount) {
    return { ok: false, status: 409, code: 'MACHINE_LIMIT_EXCEEDED' };
  }
  return { ok: true };
}

module.exports = { canRegisterDevice };
