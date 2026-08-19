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

// ── 계정 설정 탭 (CLAW-204) ──

test('제거 안내가 약속한 계정 설정 기능이 화면에 모두 있다', () => {
  // 문서는 "계정 설정 화면에서 직접" 할 수 있다고 고지하는데 화면이 없던 것이 이 이슈의 발단이다.
  // 문서를 낮추는 대신 화면을 맞췄으므로, 셋 중 하나라도 사라지면 다시 불일치가 된다.
  const guide = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'legal', 'public', 'removal-guide.html'), 'utf8');
  assert.match(guide, /계정 설정 화면/, '제거 안내가 계정 설정 화면을 안내해야 한다');
  assert.ok(HTML.includes('acctPane'), '계정 탭 화면이 있어야 한다');
  for (const control of ['askWithdraw()', 'exportMyData()', 'releaseMachine(']) {
    assert.ok(HTML.includes(control), `${control} 경로가 화면에 있어야 한다`);
  }
});

test('계정 탭이 이용자 권리 API를 호출한다', () => {
  assert.ok(HTML.includes('/v1/me/export'), '데이터 내보내기 호출이 있어야 한다');
  assert.ok(HTML.includes("api('/v1/machines')"), '기기 목록 호출이 있어야 한다');
  // 기기 ID가 경로에 들어가므로 이스케이프 없이 붙이면 안 된다.
  assert.match(HTML, /\/v1\/machines\/\$\{encodeURIComponent\(machineId\)\}/, '기기 해제 경로를 이스케이프해야 한다');
});

test('탈퇴는 DELETE /v1/me를 부르고 미교환 리워드 소멸을 고지한다', () => {
  const confirm = HTML.slice(HTML.indexOf('function askWithdraw'), HTML.indexOf('function askForfeit'));
  assert.match(confirm, /소멸/, '리워드 소멸 고지가 있어야 한다');
  assert.match(confirm, /환급되지 않습니다/, '환급 불가 고지가 있어야 한다');

  const withdraw = HTML.slice(HTML.indexOf('async function doWithdraw'), HTML.indexOf('function showWithdrawError'));
  assert.ok(withdraw.includes("api('/v1/me'"), '탈퇴는 /v1/me를 호출해야 한다');
  assert.match(withdraw, /method:\s*'DELETE'/, '탈퇴는 DELETE여야 한다');

  // 서버가 돌려준 차단 사유는 화면이 미리 판단하지 않고 그대로 안내한다.
  for (const code of ['REDEMPTION_IN_PROGRESS', 'UNPAID_CONFIRMED_REWARDS']) {
    assert.ok(HTML.includes(code), `${code} 안내가 있어야 한다`);
  }
});

test('확정 리워드 포기는 별도 동의를 거쳐야 한다', () => {
  const withdraw = HTML.slice(HTML.indexOf('async function doWithdraw'), HTML.indexOf('function showWithdrawError'));
  assert.ok(!/forfeitConfirmedRewards:\s*true/.test(withdraw), '포기를 하드코딩해 보내면 안 된다');
  assert.match(withdraw, /forfeitConfirmedRewards:\s*Boolean\(forfeitConfirmedRewards\)/, '포기 여부는 인자로만 결정한다');
  assert.match(withdraw, /forfeitConsent/, '포기는 전용 동의 체크박스를 확인해야 한다');
});

test('포기할 금액은 서버 응답값만 표시한다 (클라이언트가 계산하지 않는다)', () => {
  const forfeit = HTML.slice(HTML.indexOf('function askForfeit'), HTML.indexOf('async function doWithdraw'));
  assert.match(forfeit, /confirmedPoints/, '서버가 보낸 confirmedPoints를 써야 한다');
  assert.ok(!/\bbalance\b/.test(forfeit), '화면 잔액 변수로 대체하면 안 된다');
});

// Dockerfile이 파일 allowlist로 COPY하므로, 페이지가 참조하는 로컬 자산이 목록에서 빠지면
// 배포본에서만 404가 난다 — 로컬·CI는 파일이 있으니 전부 통과한다 (CLAW-203, mascot-working.svg 실사고).
test('페이지가 참조하는 로컬 자산이 전부 배포 이미지에 들어간다', () => {
  const dir = path.join(__dirname, '..', 'apps', 'user-web');
  const dockerfile = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
  const copied = new Set(
    dockerfile.split('\n')
      .filter((line) => line.startsWith('COPY apps/user-web/'))
      .flatMap((line) => line.split(/\s+/))
      .filter((token) => token.startsWith('apps/user-web/'))
      .map((token) => token.slice('apps/user-web/'.length)),
  );

  for (const page of ['index.html', 'install.html', 'survey.html']) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    // src/href의 상대 경로만 본다. 절대 URL·프래그먼트·디렉터리 링크는 대상이 아니다.
    for (const [, ref] of html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)) {
      if (ref.endsWith('/') || ref.includes('/')) continue; // legal/ 하위는 별도 디렉터리로 배치된다
      assert.ok(copied.has(ref), `${page}가 참조하는 ${ref}이 Dockerfile COPY 목록에 없다 — 배포본에서 404가 난다`);
    }
  }
});

// 광고 차단기의 범용 요소 숨김 규칙은 도메인을 가리지 않고 클래스 이름만 보고 지운다. EasyList에
// ##.overlay-ad·##.ad-line·##.house-ad가 있어, 그런 이름을 쓰면 확장을 켠 방문자에게만 요소가 통째로
// 사라진다 — 서버에는 200으로 남아 원인을 찾기 어렵다. 실제로 설치 안내의 광고 미리보기가 그랬다 (CLAW-226).
test('user-web의 class·id에 광고 차단 목록이 노리는 ad 토큰을 쓰지 않는다 (CLAW-226)', () => {
  const dir = path.join(__dirname, '..', 'apps', 'user-web');
  for (const page of ['index.html', 'install.html', 'survey.html']) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    for (const [, attr, value] of html.matchAll(/(class|id)="([^"]+)"/g)) {
      for (const token of value.split(/\s+/)) {
        assert.doesNotMatch(token, /(^|-)ads?(-|$)/i,
          `${page}의 ${attr}="${token}"이 광고 차단 목록의 범용 규칙에 걸린다`);
      }
    }
  }
});

// 페이지마다 자기 링크를 빼면 상단 경로 이름이 페이지에 따라 달라져 위치 감각이 깨진다.
// 어디에 있든 같은 항목이 같은 순서로 보이고, 현재 위치만 aria-current로 표시한다.
test('상단 메뉴는 모든 페이지에서 같은 항목을 같은 순서로 보여준다', () => {
  const dir = path.join(__dirname, '..', 'apps', 'user-web');
  const menus = {};
  for (const page of ['index.html', 'install.html', 'survey.html']) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    const bar = html.slice(html.indexOf('<div class="xp-menubar">'), html.indexOf('</div>', html.indexOf('<div class="xp-menubar">')));
    menus[page] = [...bar.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    assert.ok(bar.includes('계정 설정'), `${page} 상단에 계정 설정이 있어야 한다`);
  }
  const [first, ...rest] = Object.values(menus);
  for (const menu of rest) assert.deepStrictEqual(menu, first, '페이지마다 메뉴가 달라지면 안 된다');
  assert.ok(first.length >= 5, '항목이 누락되면 안 된다');
});

// 계정은 탭이 아니라 상단 메뉴에서 연다. 다른 페이지에서도 같은 자리로 올 수 있어야 한다.
test('계정 화면은 탭이 아니라 #account 해시로 연다 (CLAW-204)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'apps', 'user-web', 'index.html'), 'utf8');
  assert.ok(!html.includes("showTab('acct')\">계정"), '계정은 탭 줄에 남아 있으면 안 된다');
  assert.ok(!html.includes("getElementById('tabAcct')"), '없어진 탭 버튼을 참조하면 안 된다');
  assert.match(html, /'#account': 'acct'/, '해시로 계정 화면을 열어야 한다');
  assert.match(html, /addEventListener\('hashchange'/, '같은 페이지 안에서도 해시 이동에 반응해야 한다');
  assert.match(html, /applyRouteFromHash\(\);/, '로그인 직후에도 해시를 반영해야 한다');
  // 콜백 fragment만 지운다. 무조건 지우면 다른 페이지에서 온 #account가 첫 진입에서 사라져
  // 리워드 샵이 먼저 뜨고, 사용자가 계정 설정을 한 번 더 눌러야 했다.
  assert.match(html, /if \(code \|\| error\) history\.replaceState\(/,
    '해시 제거는 code·error가 있을 때만 해야 한다');
  // 계정 설정에 와서도 창 제목이 "리워드 샵"이면 어디에 있는지 알 수 없다.
  assert.match(html, /클로애드 계정 설정/, '계정 화면의 제목 문구가 있어야 한다');
  assert.ok((html.match(/data-app-title/g) || []).length >= 4,
    '창 제목·로고·작업표시줄이 화면 제목을 함께 따라야 한다');
  assert.match(html, /applyAppTitle\(t\);/, '탭 전환이 제목을 갱신해야 한다');
});

// 제보 창구 (CLAW-235). 답변은 모달 하나에 걸지 않는다 — 실수로 닫으면 포인트 안내까지 사라진다.
test('제보는 #reports 해시로 열고 답변은 목록에 남는다 (CLAW-235)', () => {
  const dir = path.join(__dirname, '..', 'apps', 'user-web');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

  assert.match(html, /'#reports': 'reports'/, '해시로 제보 화면을 열어야 한다');
  assert.match(html, /id="reportsPane"/, '제보 화면이 있어야 한다');
  assert.match(html, /id="reportsList"/, '내 제보 목록이 있어야 한다');
  assert.match(html, /클로애드 제보하기/, '제보 화면의 창 제목이 있어야 한다');

  // 모달은 안내 역할만 한다 — 목록으로 보내는 경로가 있어야 한다.
  assert.match(html, /notifyUnreadReplies/, '안 읽은 답변을 알려야 한다');
  assert.match(html, /location\.hash = '#reports'/, '모달이 목록으로 보내야 한다');
  // 읽음 처리는 서버에 남긴다. 클라이언트 저장소에 두면 기기를 바꿀 때 다시 뜨거나 영영 안 뜬다.
  assert.match(html, /\/read`, \{ method: 'POST' \}/, '읽음 처리를 서버에 기록해야 한다');
  assert.ok(!/localStorage/.test(html), '읽음 여부를 브라우저 저장소에 두면 안 된다');

  // 자유 입력란은 규칙 §6이 막아둔 데이터가 들어올 수 있는 통로다.
  assert.match(html, /프롬프트·소스 코드·파일 경로·터미널 명령어는 넣지 마세요/, '입력 고지가 있어야 한다');
  // 이메일은 선택이고 동의가 함께 필요하다.
  assert.match(html, /id="reportConsent"/, '이메일 동의 체크박스가 있어야 한다');
  // 제보 본문은 사용자 자유 입력이다 — 이스케이프해서 넣는다.
  assert.match(html, /esc\(r\.body\)/, '제보 본문을 이스케이프해야 한다');
  assert.match(html, /esc\(r\.reply\)/, '답변을 이스케이프해야 한다');
});
