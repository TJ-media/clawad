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

test('필수 법적 고지가 있다 (비제휴·비구매/비양도·수동 발송)', () => {
  assert.ok(/제휴|후원 관계가 없습니다/.test(HTML), '비제휴 고지');
  assert.ok(/비구매형·비양도형/.test(HTML), '리워드 성격 고지');
  assert.ok(/수동 발송/.test(HTML), '수동 발송 안내');
});

test('토큰을 localStorage에 저장하지 않는다 (메모리 보관)', () => {
  assert.ok(!HTML.includes('localStorage'), 'localStorage를 쓰면 안 된다');
  assert.ok(!HTML.includes('sessionStorage'), 'sessionStorage를 쓰면 안 된다');
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
