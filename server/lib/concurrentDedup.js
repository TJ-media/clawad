'use strict';
// 동일 사용자 계정의 여러 기기에서 시간상 겹친 노출을 한 건만 인정한다 (CLAW-2 정책).
// 이는 부정행위가 아니라 중복 미인정이다. 겹친 이벤트도 원장에는 남기되 과금·리워드·유효
// 노출 집계에서는 제외하고 거절 사유 CONCURRENT_USER_IMPRESSION을 붙인다.
//
// 이 함수는 결정적 판정 규칙만 담당한다(순수 함수). 운영에서는 PostgreSQL 트랜잭션과
// 잠금/유니크 제약으로 서로 다른 기기·서버 인스턴스의 동시 도착에도 한 건만 승인되게 한다.
// 메모리 변수나 단일 프로세스 캐시에만 의존하지 않는다.

const CONCURRENT_REASON = 'CONCURRENT_USER_IMPRESSION';

// 두 구간이 허용 오차(toleranceMs)를 감안해 겹치는가.
function overlaps(a, b, toleranceMs) {
  return a.startedAt <= b.endedAt + toleranceMs && b.startedAt <= a.endedAt + toleranceMs;
}

// 같은 시작 시각일 때의 안정적 결정 규칙: 먼저 확정된 것(id 오름차순, 없으면 impressionKey 사전순).
function earlierWins(a, b) {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt;
  const ka = String(a.confirmSeq ?? a.impressionKey ?? '');
  const kb = String(b.confirmSeq ?? b.impressionKey ?? '');
  return ka <= kb;
}

// candidate를 이미 승인된 acceptedForUser(같은 userId)와 비교해 판정한다.
// 반환: { decision: 'ACCEPTED' } 또는 { decision: 'REJECTED', reason }
function decideConcurrent(candidate, acceptedForUser, toleranceMs) {
  for (const accepted of acceptedForUser) {
    if (!overlaps(candidate, accepted, toleranceMs)) continue;
    // 겹치는 승인 노출이 이미 있다. 더 먼저인 쪽이 인정된다.
    if (earlierWins(accepted, candidate)) {
      return { decision: 'REJECTED', reason: CONCURRENT_REASON };
    }
    // candidate가 더 먼저면 기존 승인분을 밀어내야 하지만, append-only 원장에서는
    // 확정 순서상 먼저 확정된 것을 유지한다. 실제 서버는 확정 트랜잭션에서 한 건만 승인하므로
    // 여기서는 보수적으로 candidate를 거절한다(이미 확정된 겹침 존재).
    return { decision: 'REJECTED', reason: CONCURRENT_REASON };
  }
  return { decision: 'ACCEPTED' };
}

module.exports = { decideConcurrent, overlaps, CONCURRENT_REASON };
