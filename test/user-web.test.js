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
  for (const p of ['google', 'kakao']) {
    assert.ok(HTML.includes(`startSocial('${p}')`), `${p} 로그인 버튼이 있어야 한다`);
  }
  // Naver는 운영 OAuth 공개(CLAW-60) 전까지 비활성: 시작 핸들러에 연결하지 않고 disabled 버튼만 둔다.
  assert.ok(!HTML.includes("startSocial('naver')"), 'Naver 로그인은 아직 비활성이어야 한다');
  assert.match(HTML, /class="social-off" disabled[^>]*>Naver 준비 중</, 'Naver 준비 중 비활성 버튼이 있어야 한다');
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

test('CLI 위임 로그인은 loopback 복귀 주소만 받고 동의 후에 시작한다 (CLAW-100)', () => {
  // 외부 주소가 주입되면 handoff code가 새어 나간다. 스킴·호스트·경로를 모두 고정 검사해야 한다.
  assert.match(HTML, /cli_return/);
  assert.match(HTML, /url\.protocol !== 'http:' \|\| url\.hostname !== '127\.0\.0\.1' \|\| url\.pathname !== '\/callback'/);
  assert.match(HTML, /url\.username \|\| url\.password \|\| url\.search \|\| url\.hash/);
  // CLI 콜백은 이 페이지를 거치지 않으므로 소셜 시작 전에 동의를 받아야 한다.
  assert.match(HTML, /renderConsentModal\(`\$\{label\} 계정으로 클로애드 CLI 로그인`/);
  assert.match(HTML, /searchParams\.set\(CONSENT_PARAM\[consent\.type\], consent\.documentVersion\)/);
  // 기존 웹 세션으로 샵에 들어가면 터미널은 handoff를 받지 못한다.
  assert.match(HTML, /if \(cliReturn\) \{[\s\S]{0,400}?return;/);
  // 토큰은 loopback으로 넘기지 않는다. 넘어가는 값은 handoff code와 문서 버전뿐이다.
  assert.doesNotMatch(HTML, /cliReturn[\s\S]{0,200}accessToken/);
});

// --- 만족도 설문 (CLAW-97) ---

const SURVEY_HTML = fs.readFileSync(path.join(__dirname, '..', 'apps', 'user-web', 'survey.html'), 'utf8');

test('설문 페이지는 자체 구현이다 (외부 폼으로 내보내지 않는다)', () => {
  assert.ok(!/docs\.google\.com|forms\.gle|typeform|surveymonkey/i.test(SURVEY_HTML),
    '외부 설문 폼 링크가 없어야 한다');
  assert.ok(SURVEY_HTML.includes('/v1/survey/status'), '설문 상태 API를 호출해야 한다');
  assert.ok(SURVEY_HTML.includes('/v1/survey/responses'), '설문 제출 API를 호출해야 한다');
});

test('설문 제출은 로그인 세션을 요구한다', () => {
  assert.ok(SURVEY_HTML.includes('ClawadSessionClient.createSessionClient'), '세션 클라이언트를 재사용해야 한다');
  assert.ok(SURVEY_HTML.includes('loginRequired'), '미로그인 안내 화면이 있어야 한다');
  assert.ok(!/localStorage|sessionStorage/.test(SURVEY_HTML), '토큰을 브라우저 저장소에 두면 안 된다');
});

test('설문 리워드 포인트를 화면에 하드코딩하지 않는다', () => {
  // 적립 포인트·설문 버전은 서버 응답(status.rewardPoints / status.surveyVersion)에서만 온다.
  assert.ok(SURVEY_HTML.includes('status.rewardPoints'), '적립 포인트는 서버 값을 써야 한다');
  assert.ok(SURVEY_HTML.includes('status.surveyVersion'), '설문 버전은 서버 값을 써야 한다');
  assert.doesNotMatch(SURVEY_HTML, /500\s*P/, '포인트 값을 화면에 고정해 두면 안 된다');
  assert.doesNotMatch(SURVEY_HTML, /const SURVEY_VERSION\s*=/, '설문 버전을 클라이언트에 고정하면 안 된다');
});

test('설문 8문항과 재제출 차단 안내가 있다', () => {
  for (const key of ['usagePeriod', 'overallSatisfaction', 'adInterference', 'accrualSpeed',
    'catalogSatisfaction', 'onboardingIssues', 'continueIntent', 'improvements']) {
    assert.ok(SURVEY_HTML.includes(`'${key}'`), `${key} 문항이 있어야 한다`);
  }
  assert.ok(SURVEY_HTML.includes('ALREADY_SUBMITTED'), '재제출 응답을 처리해야 한다');
  assert.ok(SURVEY_HTML.includes('alreadyDone'), '이미 응답한 사용자 화면이 있어야 한다');
});

test('설문 응답이 계정과 연결됨을 고지한다', () => {
  assert.ok(/계정과 연결해 저장/.test(SURVEY_HTML), '계정 연결 사실을 고지해야 한다');
  assert.ok(!/계정·기기 정보와 연결하지 않습니다/.test(SURVEY_HTML), '사실과 다른 비연결 고지가 남아 있으면 안 된다');
  assert.ok(/접속 IP와 기기 하드웨어 정보는 수집하지 않습니다/.test(SURVEY_HTML), 'IP 미수집을 고지해야 한다');
});

test('설문 응답은 DOM API로만 렌더링한다 (XSS 방어)', () => {
  // 라벨·서버 응답을 innerHTML로 넣지 않는다.
  assert.ok(!/\.innerHTML\s*=/.test(SURVEY_HTML.split('<script')[2] || ''), 'innerHTML 대입이 없어야 한다');
  assert.ok(SURVEY_HTML.includes('createElement'), 'DOM API로 문항을 만들어야 한다');
});

test('설문 화면의 선택지 코드가 서버 정의와 일치한다', () => {
  // 문항 정의의 단일 원본은 서버(survey.definition.ts)다. 화면은 라벨만 갖되 코드가 어긋나면
  // 제출이 400으로 거절되므로, 양쪽 코드 목록이 같은지 정적으로 확인한다.
  const definition = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'api', 'src', 'survey', 'survey.definition.ts'), 'utf8');
  // choices 배열 안의 코드만 본다 — 'CHOICE'·'TEXT' 같은 문항 유형 리터럴은 대상이 아니다.
  const serverCodes = new Set();
  for (const block of definition.matchAll(/choices:\s*\[([^\]]*)\]/g)) {
    for (const code of block[1].matchAll(/'([A-Z][A-Z_]+)'/g)) serverCodes.add(code[1]);
  }
  assert.ok(serverCodes.size >= 20, '서버 정의에서 선택지 코드를 찾지 못했다');

  const clientCodes = new Set([...SURVEY_HTML.matchAll(/\['([A-Z][A-Z_]+)',/g)].map((m) => m[1]));
  assert.ok(clientCodes.size >= 20, '화면에서 선택지 코드를 찾지 못했다');

  for (const code of clientCodes) {
    assert.ok(serverCodes.has(code), `화면의 선택지 ${code}가 서버 정의에 없다`);
  }
  for (const code of serverCodes) {
    assert.ok(clientCodes.has(code), `서버 정의의 선택지 ${code}가 화면에 없다`);
  }

  // 자유 응답 길이 상한도 서버와 같아야 한다.
  const serverMax = definition.match(/MAX_TEXT_ANSWER_LENGTH\s*=\s*(\d+)/)[1];
  const clientMax = SURVEY_HTML.match(/MAX_TEXT\s*=\s*(\d+)/)[1];
  assert.strictEqual(clientMax, serverMax, '자유 응답 길이 상한이 서버와 달라선 안 된다');
});
