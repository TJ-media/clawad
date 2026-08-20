'use strict';
// admin-web/index.html 스모크 — 운영자 콘솔의 규칙 준수와 필수 화면 요소.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'apps', 'admin-web', 'index.html'), 'utf8');

// 알파 지급은 운영자 수동 발송이다. 이 화면이 없으면 교환 신청을 처리할 창구가 없다 (CLAW-247).
test('교환 대기 큐가 수동 발송 API를 모두 부른다 (CLAW-247)', () => {
  assert.match(HTML, /id="redeemBox"/, '대기 큐 컨테이너가 있어야 한다');
  for (const ep of [
    "'/internal/v1/redemptions/pending'",
    "/reveal-email'",
  ]) {
    assert.ok(HTML.includes(ep), `${ep} 호출이 있어야 한다`);
  }
  // deliver·fail·cancel은 공통 경로로 부른다 — 세 액션이 모두 배선돼 있어야 한다.
  for (const action of ['deliver', 'fail', 'cancel']) {
    assert.ok(HTML.includes(`, '${action}')`), `${action} 액션이 배선돼야 한다`);
  }
  assert.match(HTML, /'\/internal\/v1\/redemptions\/' \+ id \+ '\/' \+ action/, '액션 경로를 조립해야 한다');
});

// CLAW-74: 발송 주소 원문은 목록에 싣지 않고, 감사 기록되는 reveal 액션으로만 본다.
test('대기 큐 목록은 마스킹된 발송 주소만 쓴다 (CLAW-74)', () => {
  assert.match(HTML, /r\.deliveryEmailMasked/, '목록은 마스킹 값을 읽어야 한다');
  assert.ok(!/r\.deliveryEmail\b/.test(HTML), '목록 렌더링에서 발송 주소 원문을 읽으면 안 된다');
  // reveal은 POST여야 감사 인터셉터가 호출 사실을 남긴다.
  assert.match(HTML, /reveal-email'[\s\S]{0,60}method: 'POST'/, 'reveal은 POST여야 한다');
});

// 운영자가 입력한 상품명·브랜드·메모가 그대로 들어오는 자리다.
test('운영자 입력값을 이스케이프해서 넣는다', () => {
  for (const field of ['r.productBrand', 'r.productName', 'r.deliveryEmailMasked']) {
    assert.ok(HTML.includes(`esc(${field})`), `${field}를 이스케이프해야 한다`);
    // 이스케이프 없는 직접 삽입이 남아 있으면 안 된다.
    assert.ok(!HTML.includes(`+ ${field} +`), `${field}를 이스케이프 없이 넣으면 안 된다`);
  }
});

// 세 액션 모두 되돌릴 수 없는 원장 전이를 만든다 (지급 완료·포인트 원복).
test('되돌릴 수 없는 교환 처리는 확인을 거친다', () => {
  assert.match(HTML, /if \(!confirm\(meta\.ask\)\) return;/, '확인 없이 전이하면 안 된다');
  assert.match(HTML, /되돌릴 수 없습니다/, '되돌릴 수 없음을 화면에 알려야 한다');
});

// 쿠폰 코드 원문은 어디에도 저장하지 않는다 — 참조 메모에 넣지 않게 막는다.
test('발송 참조 메모에 쿠폰 코드를 넣지 말라고 고지한다', () => {
  assert.match(HTML, /쿠폰 코드는 넣지 마세요/, '입력 고지가 있어야 한다');
});

// 권한은 서버가 강제한다. 화면은 403을 사고가 아니라 권한 안내로 보여준다.
test('SETTLER 권한이 없으면 오류가 아니라 안내를 보여준다', () => {
  assert.match(HTML, /e\.status === 403/, '403을 구분해 처리해야 한다');
});

// rules §2 — 금액·자격은 서버가 정한다. 화면이 계산하지 않는다.
test('교환 화면이 포인트를 계산하지 않는다', () => {
  const section = HTML.slice(HTML.indexOf('교환 대기 큐 (CLAW-247)'), HTML.indexOf('---- kill switch ----'));
  assert.ok(section.length > 0, '교환 큐 스크립트 구간을 찾아야 한다');
  assert.match(section, /r\.pointsDebited/, '서버가 준 차감액을 그대로 표시해야 한다');
  assert.ok(!/pointCost\s*[-*/+]|[-*/+]\s*pointsDebited/.test(section), '화면에서 금액을 계산하면 안 된다');
});
