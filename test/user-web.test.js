'use strict';
// user-web/index.html 스모크 (CLAW-36) — 정적 웹 무결성·규칙 준수.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'apps', 'user-web', 'index.html'), 'utf8');

test('필수 화면 요소가 있다 (로그인·잔액·카탈로그·내역)', () => {
  for (const marker of ['loginView', 'shopView', 'balance', 'catalog', 'histPane']) {
    assert.ok(HTML.includes(marker), `${marker}가 있어야 한다`);
  }
});

test('공개 로그인은 소셜 전용이다 (이메일/비밀번호 폼 없음)', () => {
  // Google·Kakao·Naver 시작 + handoff 교환 엔드포인트를 호출한다.
  for (const ep of ['/v1/auth/social/', '/v1/auth/social/exchange']) {
    assert.ok(HTML.includes(ep), `${ep} 호출이 있어야 한다`);
  }
  for (const p of ['google', 'kakao', 'naver']) {
    assert.ok(HTML.includes(`startSocial('${p}')`), `${p} 로그인 버튼이 있어야 한다`);
  }
  // 이메일/비밀번호 로그인 흔적이 없어야 한다.
  assert.ok(!HTML.includes('/v1/auth/login'), '이메일 로그인 엔드포인트가 없어야 한다');
  assert.ok(!/type="password"/.test(HTML), '비밀번호 입력이 없어야 한다');
});

test('리워드 API를 호출한다', () => {
  for (const ep of ['/v1/rewards', '/v1/rewards/products', '/v1/rewards/redeem', '/v1/rewards/redemptions']) {
    assert.ok(HTML.includes(ep), `${ep} 호출이 있어야 한다`);
  }
});

test('정책값과 출시 단계는 서버의 공개 정책 API에서 읽는다', () => {
  assert.ok(HTML.includes('/v1/policy'));
  assert.match(HTML, /reward\.minimumRedemptionPoints/);
  assert.match(HTML, /publicPolicy\.releaseStage/);
  assert.doesNotMatch(HTML, /const\s+(?:MINIMUM_REDEMPTION|DAILY_REWARD|REWARD_PER_THOUSAND)/);
});

test('운영 user-web은 같은 origin API와 HTTPS만 허용한다', () => {
  assert.match(HTML, /localDevelopment \? 'http:\/\/localhost:3111' : location\.origin/);
  assert.match(HTML, /location\.protocol !== 'https:'/);
});

test('필수 법적 고지가 있다 (비제휴·비구매/비양도·수동 발송)', () => {
  assert.ok(/제휴|후원 관계가 없습니다/.test(HTML), '비제휴 고지');
  assert.ok(/비구매형·비양도형/.test(HTML), '리워드 성격 고지');
  assert.ok(/수동 발송/.test(HTML), '수동 발송 안내');
});

test('토큰을 localStorage에 저장하지 않는다 (메모리 보관)', () => {
  assert.ok(!HTML.includes('localStorage'), 'localStorage를 쓰면 안 된다');
  assert.ok(!HTML.includes('sessionStorage'), 'sessionStorage를 쓰면 안 된다');
});

test('세션 만료 복구와 탭별 로딩·오류·재시도 UI가 있다', () => {
  assert.ok(HTML.includes('./session-client.js'), '세션 복구 API 클라이언트를 로드해야 한다');
  for (const marker of ['balanceState', 'catalogState', 'historyState']) {
    assert.ok(HTML.includes(marker), `${marker} 상태 영역이 있어야 한다`);
  }
  for (const loader of ['loadBalance()', 'loadProducts()', 'loadHistory()']) {
    assert.ok(HTML.includes(loader), `${loader} 재시도 동작이 있어야 한다`);
  }
  assert.match(HTML, /role="status" aria-live="polite"/, '상태 안내는 보조기술에 전달돼야 한다');
  assert.match(HTML, /id="loginErr" role="alert" aria-live="assertive"/, '세션 종료 이유는 즉시 보조기술에 전달돼야 한다');
  assert.doesNotMatch(HTML, /\balert\s*\(/, '브라우저 alert를 오류·성공 UI로 사용하면 안 된다');
});

test('교환 시 발송 이메일을 입력·동의받아 전송한다 (CLAW-74)', () => {
  // 모달에 이메일 입력과 동의 체크박스가 있다.
  assert.match(HTML, /id="redeemEmail"/, '발송 이메일 입력이 있어야 한다');
  assert.match(HTML, /id="redeemConsent"/, '이메일 수집 동의 체크박스가 있어야 한다');
  // redeem 요청 본문에 deliveryEmail과 동의를 실어 보낸다.
  assert.match(HTML, /deliveryEmail,\s*deliveryEmailConsent:\s*true/, 'redeem 본문에 발송 이메일·동의를 보내야 한다');
  // 형식 검사와 미동의 차단이 있다.
  assert.match(HTML, /function isValidEmail\(/, '이메일 형식 즉시 검사가 있어야 한다');
  assert.match(HTML, /이메일 수집·이용 동의가 필요합니다/, '미동의 시 차단 안내가 있어야 한다');
  // 내역에는 서버가 준 마스킹 값만 쓰고 원문 필드를 읽지 않는다.
  assert.match(HTML, /deliveryEmailMasked/, '내역은 마스킹된 발송 주소를 표시해야 한다');
  assert.doesNotMatch(HTML, /r\.deliveryEmail\b(?!Masked)/, '원문 발송 이메일 필드를 렌더링하면 안 된다');
});

test('교환 멱등 키를 의도별로 생성·유지한다 (CLAW-73)', () => {
  // 모달을 여는 순간(=새 의도) UUID 키를 만들고, 요청 본문에 실어 보낸다.
  assert.match(HTML, /redeemIntentKey = crypto\.randomUUID\(\)/, '모달 오픈 시 의도별 키를 생성해야 한다');
  assert.match(HTML, /idempotencyKey: redeemIntentKey/, 'redeem 요청에 멱등 키를 보내야 한다');
  // 불확실 오류 동안 키를 유지하고(재시도 같은 키), 확정 성공에서만 폐기한다.
  assert.match(HTML, /redeemIntentKey = null; \/\/ 확정 성공/, '확정 성공 시에만 키를 폐기해야 한다');
});

test('중복 제출 방지와 안전한 세션 상태 초기화가 있다', () => {
  assert.match(HTML, /if \(socialBusy\) return/);
  assert.match(HTML, /if \(redeemBusy\) return/);
  assert.match(HTML, /if \(historyPromise\) return historyPromise/);
  assert.match(HTML, /function resetSession\(reason\)/);
  assert.match(HTML, /sessionClient\.clearAccessToken\(\)/);
  assert.match(HTML, /viewEpoch \+= 1/);
  assert.match(HTML, /epoch !== viewEpoch/);
});

test('초기 silent refresh 실패도 만료·철회·오프라인 이유를 안내한다', () => {
  assert.match(HTML, /저장된 로그인 세션이 없거나 만료·철회되었습니다/);
  assert.match(HTML, /오프라인 상태라 로그인 세션을 확인하지 못했습니다/);
  assert.match(HTML, /e\.status === 401/);
  assert.match(HTML, /e\.code === 'NETWORK_UNAVAILABLE'/);
});

test('결제·충전 기능이 없다 (리워드 비구매형)', () => {
  // 고지문은 "충전·양도·현금 환급을 지원하지 않습니다"로 충전을 명시적으로 부정한다.
  assert.ok(/충전·양도·현금 환급을 지원하지 않습니다/.test(HTML), '비구매형 고지가 있어야 한다');
  // 실제 결제·장바구니 기능(엔드포인트·핸들러)은 없어야 한다.
  assert.ok(!/장바구니|addToCart|checkout|\/payments?|\/charge/i.test(HTML), '결제/장바구니 기능이 없어야 한다');
});

test('사용자 입력을 이스케이프한다 (XSS 방어)', () => {
  assert.ok(HTML.includes('function esc('), 'esc 헬퍼가 있어야 한다');
});

test('서버의 활성 법률 문서를 로그인 전에 표시하고 항목별 동의를 받는다', () => {
  assert.ok(HTML.includes('/v1/legal/documents'), '서버 법률 문서 API를 호출해야 한다');
  assert.ok(HTML.includes('legalNotice'), '로그인 화면에 운영 문서를 표시해야 한다');
  assert.ok(HTML.includes('termsConsent'), '이용약관 동의가 독립 항목이어야 한다');
  assert.ok(HTML.includes('privacyConsent'), '개인정보처리방침 동의가 독립 항목이어야 한다');
  assert.ok(HTML.includes('documentVersion: document.version'), '서버 버전을 동의 결과에 사용해야 한다');
  assert.doesNotMatch(HTML, /const CONSENT_VERSION\s*=/, '클라이언트에 동의 버전을 하드코딩하면 안 된다');
  assert.match(HTML, /button class="social" disabled/, '문서를 불러오기 전 OAuth 버튼이 비활성화돼야 한다');
  assert.match(HTML, /if \(r\.signupRequired \|\| r\.consentRequired\) \{\s*await loadLegalDocuments\(\)/,
    '동의 모달 직전에 최신 문서를 다시 조회해야 한다');
  assert.match(HTML, /CONSENT_VERSION_INVALID/);
  assert.match(HTML, /removalGuideUrl/);
  assert.match(HTML, /privacyContactUrl/);
});
