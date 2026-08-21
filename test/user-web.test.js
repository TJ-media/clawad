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
  for (const page of ['index.html', 'install.html', 'survey.html', 'creative/index.html']) {
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
  // 계정 설정에 와서도 창 제목이 "리워드 샵"이면 어디에 있는지 알 수 없다. 창이 여러 개
  // 뜨는 지금은 창마다 제목이 박혀 있고(APP_TITLES), 문서 제목만 활성 창을 따라간다 (CLAW-253).
  assert.match(html, /클로애드 계정 설정/, '계정 화면의 제목 문구가 있어야 한다');
  assert.match(html, /applyAppTitle\(t\);/, '창 전환이 제목을 갱신해야 한다');
  assert.match(html, /document\.title = title;/, '문서 제목이 활성 창을 따라야 한다');
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

// ── XP 데스크톱 셸 (CLAW-253) ────────────────────────────────────────────
// 창 버튼과 작업 표시줄이 장식이던 시절의 흔적(aria-hidden span)이 남으면 보조기술에는
// 누를 수 있는 것처럼 보이고 실제로는 아무 일도 일어나지 않는다.
test('창 제어 버튼과 작업 표시줄이 실제로 동작하는 컨트롤이다 (CLAW-253)', () => {
  assert.ok(!/<span class="xp-buttons" aria-hidden="true">/.test(
    HTML.slice(HTML.indexOf('id="desktop"'))), '데스크톱 창의 제어 버튼이 장식이면 안 된다');
  for (const control of ['minimizeWindow(', 'toggleMaximize(', 'closeWindow(']) {
    assert.ok(HTML.includes(control), `${control} 동작이 있어야 한다`);
  }
  // 작업 표시줄 항목은 클릭·우클릭을 모두 받는다.
  assert.match(HTML, /taskList\.addEventListener\('click'/, '작업 표시줄 클릭을 처리해야 한다');
  assert.match(HTML, /taskList\.addEventListener\('contextmenu'/, '작업 표시줄 우클릭을 처리해야 한다');
  assert.match(HTML, /event\.preventDefault\(\);\s*\n\s*openContextMenu\(/, '브라우저 기본 메뉴를 막아야 한다');
  // 활성 창을 다시 누르면 최소화된다 — 누를 때마다 앞으로만 오면 내릴 방법이 없다.
  assert.match(HTML, /focusedWindow === id && !winEl\(id\)\.classList\.contains\('win-min'\)/,
    '활성 창을 다시 누르면 최소화해야 한다');
  // 드래그는 포인터 캡처로 잡는다. 캡처가 없으면 커서가 창 밖으로 나가는 순간 놓친다.
  assert.match(HTML, /capturePointer\(bar, event\.pointerId\)/, '타이틀바 드래그는 포인터를 캡처해야 한다');
  // 캡처가 실패했다고 조작 자체가 죽으면 안 된다 — 커서가 요소 위에 있는 동안은 따라와야 한다.
  assert.match(HTML, /try \{ el\.setPointerCapture\(pointerId\); \} catch/, '캡처 실패를 삼켜야 한다');
});

// 시작 메뉴·상단 메뉴·창 제목은 WINDOWS 표 하나에서 나온다. 갈라지면 어느 쪽으로 들어왔느냐에
// 따라 갈 수 있는 곳이 달라진다.
test('시작 메뉴가 상단 메뉴 항목을 같은 순서로 담는다 (CLAW-253)', () => {
  const menubar = HTML.slice(HTML.indexOf('<div class="xp-menubar">'),
    HTML.indexOf('</div>', HTML.indexOf('<div class="xp-menubar">')));
  const menuHrefs = [...menubar.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  const startItems = [...HTML.slice(HTML.indexOf('id="startMenu"'))
    .matchAll(/openFromStart\('([a-z]+)'\)/g)].map((m) => m[1]);

  const table = HTML.slice(HTML.indexOf('const WINDOWS = {'), HTML.indexOf('// 로그인 여부.'));
  const rows = [...table.matchAll(/(\w+): \{ title: '([^']+)', icon: '([^']+)'(?:, href: '([^']+)')?/g)];
  const hrefById = Object.fromEntries(rows.map((m) => [m[1], m[4]]));

  // 상단 메뉴는 사용자용 6개다. 시작 메뉴는 그것을 같은 순서로 담고 광고주 창을 더 갖는다.
  assert.deepStrictEqual(rows.filter((m) => m[4]).map((m) => m[4]), menuHrefs,
    'WINDOWS 표의 href 순서가 상단 메뉴와 같아야 한다');
  assert.deepStrictEqual(startItems.map((id) => hrefById[id]).filter(Boolean), menuHrefs,
    '시작 메뉴가 상단 메뉴 항목을 같은 순서로 담아야 한다');
  assert.ok(startItems.includes('creative'), '광고 신청·미리보기는 시작 메뉴에서 연다');
  // 광고주 창은 사용자 6개 메뉴에 섞지 않는다 — 상단 메뉴를 고치면 다른 페이지도 다 고쳐야 한다.
  assert.ok(!menuHrefs.includes('/creative'), '상단 메뉴에 광고주 창을 넣으면 안 된다');
  for (const [, , , icon] of rows) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'apps', 'user-web', 'icons', `${icon}.png`)),
      `창 아이콘 ${icon}.png가 없다`);
  }
});

// 상단 메뉴가 리워드 샵 창에만 있으면 계정·제보에서 다른 화면으로 갈 길이 없다. 원본은 하나이고
// 나머지는 복제본이다 — 항목이 갈라질 여지를 두지 않는다.
test('사용자 창은 모두 같은 상단 메뉴를 가진다 (CLAW-253)', () => {
  assert.match(HTML, /function cloneMenubars\(\)/, '메뉴를 창마다 복제해야 한다');
  assert.match(HTML, /el\.insertBefore\(menubar\.cloneNode\(true\), el\.children\[1\]\)/,
    '메뉴는 제목 표시줄 바로 아래에 온다');
  assert.strictEqual((HTML.match(/<div class="xp-menubar">/g) || []).length, 1,
    '정적 메뉴는 하나여야 한다 — 손으로 복사하면 갈라진다');
  assert.match(HTML, /cloneMenubars\(\);/, '초기화에서 복제를 실행해야 한다');
  // 로그인·광고주 창은 사용자 메뉴에 속하지 않는다.
  assert.match(HTML, /if \(!MENU_HREFS\[el\.dataset\.win\]\) continue;/, '메뉴 없는 창은 건너뛴다');
});

// 창마다 제목·아이콘이 있어야 작업 표시줄과 우클릭 메뉴가 그 창을 이름으로 부를 수 있다.
test('모든 창이 WINDOWS 표에 등록돼 있다 (CLAW-253)', () => {
  const table = HTML.slice(HTML.indexOf('const WINDOWS = {'), HTML.indexOf('// 로그인 여부.'));
  const known = new Set([...table.matchAll(/^\s{8}(\w+): \{ title:/gm)].map((m) => m[1]));
  const stat = new Set([...HTML.matchAll(/data-win="([a-z]+)"/g)].map((m) => m[1]));
  const built = new Set([...table.matchAll(/^\s{8}(\w+): \{ title:.*doc: '/gm)].map((m) => m[1]));

  for (const id of stat) assert.ok(known.has(id), `창 ${id}가 WINDOWS 표에 없다`);
  for (const id of built) assert.ok(!stat.has(id), `문서 창 ${id}를 마크업에도 두면 두 벌이 된다`);
  assert.strictEqual(stat.size + built.size, known.size, '표에만 있고 만들지 않는 창이 남으면 안 된다');
});

// 창은 누구나 연다. 무엇이 있는지 보고 나서 로그인할지 정할 수 있어야 한다.
// 대신 실행 버튼을 잠그고, 누르면 보고 있던 창을 닫지 않은 채 로그인 창을 띄운다.
test('로그인 전에도 창은 열리고 버튼만 잠긴다 (CLAW-253)', () => {
  const open = HTML.slice(HTML.indexOf('function openWindow(id, options = {})'), HTML.indexOf('function readGeometry'));
  assert.ok(!/id = 'login';/.test(open), '창을 로그인 창으로 바꿔치기하면 보던 화면이 사라진다');

  // 잠그는 컨트롤 목록. 이 중 하나라도 빠지면 로그인 전에 실제 요청이 나간다.
  const locked = HTML.slice(HTML.indexOf('const LOCKED_CONTROLS = ['), HTML.indexOf('function applyLockedControls'));
  for (const id of ['reportSubmit', 'exportButton', 'withdrawButton']) {
    assert.ok(locked.includes(`'${id}'`), `${id}을 잠가야 한다`);
  }
  // 교환·기기 해제는 동적으로 그려지므로 렌더 함수 안에서 잠근다.
  assert.match(HTML, /data-needs-login="상품 교환"/, '교환 버튼을 잠가야 한다');
  assert.match(HTML, /data-needs-login="기기 해제"/, '기기 해제 버튼을 잠가야 한다');

  // 진짜 disabled면 눌러도 아무 일이 없어 왜 막혔는지 알 수 없다 — 눌리되 로그인으로 보낸다.
  const guard = HTML.slice(HTML.indexOf('function requireLogin(what)'), HTML.indexOf('function loadShopWindow'));
  assert.match(guard, /showToast\(/, '왜 막혔는지 알려야 한다');
  assert.match(guard, /openWindow\('login'\)/, '로그인 창을 띄워야 한다');
  assert.match(guard, /winEl\('login'\)\.focus/, '로그인 창으로 포커스를 옮겨야 한다');
  assert.ok(!/closeWindow/.test(guard), '보고 있던 창을 닫으면 안 된다');
  // 인라인 onclick보다 먼저 멈춰야 제출·탈퇴가 실제로 나가지 않는다.
  assert.match(HTML, /requireLogin\(locked\.dataset\.needsLogin\);[\s\S]{0,20}\}, true\);/,
    '잠긴 클릭은 캡처 단계에서 가로채야 한다');
  assert.match(HTML, /event\.stopPropagation\(\);[\s\S]{0,60}requireLogin\(/, '원래 동작을 막아야 한다');

  // 세션이 필요한 조회는 로그인 전에 아예 부르지 않는다.
  // 카탈로그는 무인증 공개다 — 로그인 전에도 무엇을 교환할 수 있는지 보여야 한다.
  const shop = HTML.slice(HTML.indexOf('function loadShopWindow()'), HTML.indexOf('function loadAcctWindow'));
  assert.match(shop, /loadProducts\(\);/, '로그인 전에도 카탈로그를 불러와야 한다');
  for (const fn of ['loadAcctWindow', 'loadReportsWindow']) {
    const body = HTML.slice(HTML.indexOf(`function ${fn}()`), HTML.indexOf('}', HTML.indexOf(`function ${fn}()`)));
    assert.match(body, /if \(signedIn\)/, `${fn}은 로그인 여부를 봐야 한다`);
  }
});

// 법률 문서는 배포 파이프라인 밖(호스트 바인드 마운트)에 있다. 내용을 복사해 오면
// 원본을 고쳐도 창 안의 사본은 옛 문서를 계속 보여준다.
test('설치 안내·법률 문서 창은 같은 출처 iframe으로만 싣는다 (CLAW-253)', () => {
  assert.match(HTML, /<iframe class="win-frame"/, '문서 창은 iframe이어야 한다');
  assert.match(HTML, /frame\.src = frame\.dataset\.src/, '문서는 창을 열 때 불러와야 한다');
  // 실려 온 문서가 자기 창틀·메뉴를 그리면 창 안에 창이 겹쳐 보인다.
  assert.match(HTML, /function stripDocumentChrome\(frame\)/, '문서의 창틀을 지워야 한다');
  assert.match(HTML, /body::before \{ display: none !important; \}/, '문서의 가짜 제목 표시줄을 지워야 한다');
  assert.ok(!/새 탭에서 열기/.test(HTML), '창이 곧 문서다 — 새 탭 안내를 남기지 않는다');
  const guide = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'legal', 'public', 'removal-guide.html'), 'utf8');
  assert.ok(!HTML.includes(guide.slice(guide.indexOf('<body'), guide.indexOf('<body') + 200)),
    '법률 문서 본문을 복사해 두면 안 된다');
});

// 데스크톱 은유는 터치에서 맞지 않는다. 창을 전체 화면으로 쌓되 작업 표시줄은 남긴다 —
// 창을 오갈 다른 수단이 없다.
test('좁은 화면에서는 창이 전체 화면이고 이동·최대화가 꺼진다 (CLAW-253)', () => {
  const narrow = HTML.slice(HTML.indexOf('@media (max-width: 640px)'),
    HTML.indexOf('@media (prefers-reduced-motion'));
  // 위치는 인라인 left/top으로 들어간다. !important가 없으면 좁은 화면 규칙이 진다.
  assert.match(narrow, /\.win \{[^}]*left: 0 !important/, '창을 화면에 맞춰 고정해야 한다');
  assert.match(narrow, /\.win-max-button, \.win-grip \{ display: none/, '최대화 버튼과 크기 손잡이를 숨겨야 한다');
  assert.ok(!/\.taskbar \{ display: none/.test(narrow), '작업 표시줄을 숨기면 창을 오갈 수 없다');
  assert.match(HTML, /if \(isNarrow\(\) \|\| el\.classList\.contains\('win-max'\)\) return;/,
    '좁은 화면에서는 이동·크기 조절을 시작하지 않아야 한다');
});

// 창 크기는 사용자가 정한다. 최대화·복원 두 단계만으로는 두 창을 나란히 놓을 수 없다.
test('창은 여덟 방향 손잡이로 크기를 조절한다 (CLAW-253)', () => {
  assert.match(HTML, /const RESIZE_EDGES = \['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'\]/,
    '네 변과 네 모서리를 모두 잡을 수 있어야 한다');
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    assert.ok(HTML.includes(`.win-grip[data-resize='${edge}']`), `${edge} 손잡이 위치가 정의돼야 한다`);
  }
  // 최소 크기가 없으면 타이틀바까지 접혀 창을 다시 키울 수 없다.
  assert.match(HTML, /WINDOW_MIN_WIDTH = \d+/, '최소 너비가 있어야 한다');
  assert.match(HTML, /WINDOW_MIN_HEIGHT = \d+/, '최소 높이가 있어야 한다');
  // 위·왼쪽으로 줄일 때 반대쪽 모서리가 따라 움직이면 창이 기어간다.
  assert.match(HTML, /el\.style\.left = `\$\{from\.left \+ from\.width - width\}px`/, '왼쪽 조절은 위치를 함께 옮겨야 한다');
  assert.match(HTML, /el\.style\.top = `\$\{from\.top \+ from\.height - height\}px`/, '위쪽 조절은 위치를 함께 옮겨야 한다');
  assert.match(HTML, /\.win\.win-max \.win-grip \{ display: none/, '최대화된 창은 손잡이를 잡을 수 없어야 한다');
});

// 창을 좁히면 창 안이 접혀야 한다. 뷰포트 미디어 쿼리로는 창 크기를 알 수 없다.
test('창 안 레이아웃은 뷰포트가 아니라 창 크기에 반응한다 (CLAW-253)', () => {
  assert.match(HTML, /\.win \{[^}]*container-type: inline-size/s, '창이 컨테이너여야 한다');
  assert.match(HTML, /@container \(max-width: 560px\)/, '창 너비 기준 분기가 있어야 한다');
  const container = HTML.slice(HTML.indexOf('@container (max-width: 560px)'), HTML.indexOf('/* ── 유휴 화면'));
  assert.match(container, /\.grid \{ grid-template-columns: 1fr; \}/, '좁은 창에서 상품이 한 줄로 서야 한다');
  assert.match(container, /\.xp-menubar \{ flex-wrap: wrap/, '좁은 창에서 메뉴가 접혀야 한다');
});

// 애드워드는 창 뒤에서도 계속 걷는다. 안내판만 창이 하나라도 열리면 사라진다 —
// 창을 내려놓은 사람에게 다시 창을 권할 이유가 없다.
test('애드워드는 계속 걷고 안내판만 창이 열리면 사라진다 (CLAW-253)', () => {
  assert.match(HTML, /id="idleScene"/, '바탕화면이 있어야 한다');
  // 조각 PNG를 참조하는 SVG라 <img>로는 그림이 통째로 빠진다 (CLAW-248).
  assert.match(HTML, /<object class="idle-mascot" data="\.\/creative\/assets\/clawad-mini-crabwalk\.svg"/,
    '걸어다니는 마스코트를 <object>로 실어야 한다');
  const update = HTML.slice(HTML.indexOf('function updateIdleScene()'), HTML.indexOf('// ── 데스크톱 안내판 ──'));
  assert.match(update, /const empty = openWindows\.every\(\(id\) => id === 'login'\);/,
    '로그인 창만 떠 있으면 안내판을 유지한다 — 로그인 창은 첫 화면의 일부다');
  assert.match(update, /deskNotice'\)\.classList\.toggle\('hidden', !empty\)/, '안내판만 감춰야 한다');
  assert.ok(!/idleScene'\)\.classList\.toggle/.test(update), '마스코트는 창이 떠도 남아 있어야 한다');
  // 움직임에 민감한 사용자를 위해 애니메이션을 끌 수 있어야 한다.
  assert.match(HTML, /prefers-reduced-motion: reduce\)[\s\S]{0,40}\.idle-float \{ animation: none; \}/,
    '움직임 최소화 설정을 존중해야 한다');
});

// 안내판은 오버레이가 그리는 광고판과 같은 부품이다. 자사 안내이므로 [광고]가 아니라 [안내]다.
test('데스크톱 안내판이 실제 광고판과 같은 구조다 (CLAW-253)', () => {
  const strip = HTML.slice(HTML.indexOf('id="deskNotice"'), HTML.indexOf('</button>', HTML.indexOf('id="deskNotice"')));
  for (const part of ['creative-strip', 'creative-label', 'creative-copy', 'creative-meta', 'creative-brand-output', 'creative-reward']) {
    assert.ok(strip.includes(part), `광고판 부품 ${part}가 있어야 한다`);
  }
  // 광고 인벤토리가 아니다. [광고] 표기를 붙이면 표시광고법상 광고가 아닌 것을 광고라 하는 셈이다.
  assert.match(strip, /class="creative-label">\[안내\]</, '자사 안내는 [안내]로 표기해야 한다');
  assert.ok(!strip.includes('[광고]'), '광고가 아닌 안내에 [광고]를 붙이면 안 된다');
  assert.match(HTML, /--creative-cutout-width/, '문구 컷아웃 폭을 계산해야 한다');

  const notices = HTML.slice(HTML.indexOf('const DESK_NOTICES = ['), HTML.indexOf('const NOTICE_ROTATE_MS'));
  assert.deepStrictEqual(
    [...notices.matchAll(/text: '([^']+)'/g)].map((m) => m[1]),
    ['리워드 샵 창을 띄울까요?', '설치 안내 창을 띄울까요?', '저는 클로애드의 마스코트 애드워드입니다!',
      '로그인이 필요합니다. 소셜 계정으로 로그인하세요.'],
    '안내 문구 세 가지와 미로그인 안내가 있어야 한다');
  assert.match(HTML, /NOTICE_ROTATE_MS = 10000/, '10초마다 번갈아 보여야 한다');
  assert.match(HTML, /if \(!empty\) \{ stopNoticeRotation\(\); return; \}/, '창이 뜨면 회전을 멈춰야 한다');
});

// 금액을 지어내면 "이 광고 보면 저만큼 받나?"로 읽힌다. 로그인했으면 서버가 준 잔액을 그대로 쓴다.
test('안내판 금액은 로그인 상태에 따라 갈린다 (CLAW-253)', () => {
  const render = HTML.slice(HTML.indexOf('function renderDeskNotice()'), HTML.indexOf('function startNoticeRotation'));
  assert.match(render, /const knownBalance = signedIn && balance !== null;/,
    '로그인했고 잔액을 받은 경우에만 실제 값을 쓴다');
  // 잔액은 서버 응답값만 쓴다. 화면이 계산하지 않는다 (규칙 §2).
  assert.match(render, /knownBalance\s*\?\s*`내 확정 포인트 \$\{balance\.toLocaleString\('ko-KR'\)\}P`/,
    '로그인 시 실제 잔액을 표시해야 한다');
  assert.ok(!/예상 적립 \$\{balance/.test(render), '잔액을 "예상 적립"으로 잘못 표기하면 안 된다');
  assert.match(render, /예상 적립 \$\{NOTICE_SAMPLE_POINTS/, '미로그인일 때만 예시 금액을 쓴다');
  // 잔액이 늦게 오면 안내판도 다시 그려야 한다 (CLAW-202와 같은 함정).
  const loadBalance = HTML.slice(HTML.indexOf('async function loadBalance()'), HTML.indexOf('async function loadProducts'));
  assert.match(loadBalance, /renderDeskNotice\(\)/, '잔액을 받으면 안내판을 다시 그려야 한다');
});

// 시작 메뉴 오른쪽 칸은 XP 분위기를 내는 장식이다. 눌러도 되는 것처럼 생겼으니
// 눌렀을 때 아무 일도 일어나지 않으면 고장으로 읽힌다 — 준비 중임을 알린다.
test('시작 메뉴 장식 항목은 준비 중임을 알린다 (CLAW-253)', () => {
  const menu = HTML.slice(HTML.indexOf('id="startMenu"'), HTML.indexOf('id="ctxMenu"'));
  const right = menu.slice(menu.indexOf('class="start-right"'), menu.indexOf('class="start-foot"'));
  for (const label of ['내 문서', '내 컴퓨터', '제어판(C)', '실행(R)...']) {
    assert.ok(right.includes(label), `${label} 항목이 있어야 한다`);
  }
  // 실제 창을 여는 항목과 섞이지 않도록 장식은 전부 notReady()로만 간다.
  assert.ok(!/openFromStart/.test(right), '장식 칸이 창을 열면 안 된다');
  const decorated = [...menu.matchAll(/class="start-item off"/g)].length;
  const notReady = [...menu.matchAll(/onclick="notReady\(\)"/g)].length;
  assert.strictEqual(decorated, notReady, '장식 항목은 모두 준비 중 안내로 이어져야 한다');
  assert.ok(decorated >= 12, '오른쪽 칸과 모든 프로그램까지 장식이다');
  // 누를 수 있게 된 이상 보조기술에서 숨기면 안 된다.
  assert.ok(!/class="start-right" aria-hidden/.test(HTML), '눌리는 항목을 aria-hidden으로 감추면 안 된다');
  assert.match(HTML, /function notReady\(\) \{ showToast\('아직 준비 중인 기능입니다\.'\); \}/,
    '준비 중 스낵바가 있어야 한다');

  // 왼쪽 칸은 전부 실제 창을 여는 버튼이다(사용자 6개 + 광고 신청).
  const left = menu.slice(menu.indexOf('class="start-left"'), menu.indexOf('class="start-right"'));
  assert.strictEqual((left.match(/openFromStart\('/g) || []).length, 7, '왼쪽 칸이 창 7개를 열어야 한다');
});

// 시작 메뉴의 세션 항목 하나가 로그인·로그오프를 겸한다.
test('시작 메뉴 세션 항목이 로그인 여부를 따른다 (CLAW-253)', () => {
  assert.match(HTML, /id="sessionLabel">로그인\(L\)</, '기본은 로그인이다 — 로그인 전에도 데스크톱이 보인다');
  assert.match(HTML, /onclick="toggleSession\(\)"/, '한 항목이 로그인·로그오프를 겸한다');
  assert.match(HTML, /signedIn \? '로그오프\(L\)' : '로그인\(L\)'/, '상태에 따라 글씨가 바뀌어야 한다');
  // 버튼 자체의 textContent를 쓰면 안에 있는 아이콘과 라벨 span까지 지워진다.
  const logoutFn = HTML.slice(HTML.indexOf('async function logout()'), HTML.indexOf('function resetSession'));
  assert.ok(!/button\.textContent =/.test(logoutFn), '버튼 textContent를 덮어쓰면 아이콘이 사라진다');
  assert.match(logoutFn, /getElementById\('sessionLabel'\)\.textContent = '로그아웃 중'/, '라벨만 바꿔야 한다');
});

// 기본은 창이 하나도 없는 바탕화면이다. 로그인하지 않아도 데스크톱과 작업 표시줄이 보인다.
test('로그인 전에도 데스크톱이 보이고 로그인은 창 하나다 (CLAW-253)', () => {
  // 작업 표시줄과 데스크톱에 hidden이 걸려 있으면 로그인 전 화면이 다시 반쪽이 된다.
  assert.match(HTML, /<div id="desktop">/, '데스크톱은 늘 떠 있어야 한다');
  assert.match(HTML, /<div class="taskbar" id="taskbar">/, '작업 표시줄도 늘 떠 있어야 한다');
  assert.match(HTML, /id="loginView" class="win win-login xp-window hidden" data-win="login"/,
    '로그인 화면은 창이어야 한다');
  // 로그인 창은 우측 상단에서 시작한다.
  assert.match(HTML, /place: 'top-right'/, '로그인 창의 첫 자리가 정해져 있어야 한다');
  assert.match(HTML, /if \(WINDOWS\[el\.dataset\.win\]\.place === 'top-right'\)/, '그 자리를 실제로 써야 한다');

  const enter = HTML.slice(HTML.indexOf('async function enterShop'), HTML.indexOf('// 새로고침 시 refresh'));
  assert.ok(!/openWindow\('shop'/.test(enter), '리워드 샵 창을 자동으로 열면 안 된다');
  assert.match(enter, /signedIn = true;/, '세션을 세워야 한다');
  assert.match(enter, /closeWindow\('login'\)/, '로그인하면 로그인 창을 닫아야 한다');
  // 해시가 없으면 아무 창도 열지 않는다.
  const route = HTML.slice(HTML.indexOf('function applyRouteFromHash()'), HTML.indexOf("addEventListener('hashchange'"));
  assert.match(route, /const route = HASH_ROUTES\[location\.hash\];[\s\S]{0,20}if \(route\) openWindow\(route\);/,
    '해시가 있을 때만 창을 연다');

  const reset = HTML.slice(HTML.indexOf('function resetSession(reason)'), HTML.indexOf('function setState'));
  assert.match(reset, /closeAllWindows\(\)/, '로그아웃·탈퇴는 창을 모두 닫아야 한다');
  assert.match(reset, /openWindow\('login'\)/, '로그아웃하면 로그인 창을 다시 띄운다');
  assert.ok(!/taskbar'\)\.classList\.add\('hidden'\)/.test(reset), '로그아웃해도 작업 표시줄은 남는다');
});

// 창이 하나도 없는 첫 화면에서 시작 버튼이 진입점임을 알린다.
test('시작 버튼 위에 XP 풍선 안내가 뜬다 (CLAW-253)', () => {
  assert.match(HTML, /id="startHint" class="xp-balloon hidden"/, '풍선이 있어야 한다');
  assert.match(HTML, /<b>시작 버튼<\/b>을 눌러서<br \/>클로애드 서비스를 이용할 수도 있어요!/, '안내 문구가 있어야 한다');
  assert.match(HTML, /class="xp-balloon-arrow" aria-hidden="true">↓</, '시작 버튼을 가리키는 화살표가 있어야 한다');
  assert.match(HTML, /class="xp-balloon-close" aria-label="안내 닫기"/, '닫을 수 있어야 한다');
  // id로 display를 잡으면 뒤의 .hidden이 특정성에서 져 숨기기가 먹지 않는다.
  assert.match(HTML, /\.xp-balloon \{[^}]*display: flex/s, '스타일은 class에 걸어야 한다');
  assert.ok(!/#startHint \{[^}]*display:/s.test(HTML), 'id 선택자로 display를 잡으면 .hidden이 진다');
  // 꼬리는 삼각형 둘을 겹쳐 1px 테두리를 남긴다.
  assert.match(HTML, /\.xp-balloon::before, \.xp-balloon::after/, '풍선 꼬리가 있어야 한다');
  // 시작 메뉴를 한 번 열면 할 일을 다 한 것이다.
  assert.match(HTML, /if \(open\) startHintDismissed = true;/, '시작 메뉴를 열면 안내가 사라져야 한다');
  assert.match(HTML, /startHintDismissed \|\| menuOpen/, '메뉴가 열리면 감춘다');
});

// 잔액 응답이 상품 목록보다 늦게 오면 balance가 0인 채로 카탈로그가 그려져
// 전 상품이 "부족"으로 굳었다 (CLAW-202, 2026-08-14 알파 리허설에서 4500P 계정으로 발견).
// 문자열 검사로는 못 잡아서 card()를 실제로 실행한다.
test('잔액 미확인 상태를 포인트 부족으로 렌더하지 않는다 (CLAW-202)', () => {
  const source = HTML.match(/function card\(p, anchor\) \{[\s\S]*?\n {6}\}/);
  assert.ok(source, 'card() 정의를 찾아야 한다');
  const build = new Function('balance', 'esc', 'signedIn', `${source[0]}
return card;`);
  const render = (balance, signedIn = true) =>
    build(balance, String, signedIn)({ id: 'p1', brand: 'B', name: 'N', pointCost: 1500, category: 'CAFE' }, false);

  // 로그인 전에는 잔액을 물어보지도 않는다 — 잠긴 채로 그리고 누르면 로그인 창이 뜬다.
  const anon = render(null, false);
  assert.match(anon, /data-needs-login="상품 교환"/, '로그인 전 교환 버튼은 로그인으로 보내야 한다');
  assert.ok(!/\sdisabled[\s=>]/.test(anon), '진짜 disabled면 눌러도 아무 일이 없다 — aria-disabled로만 잠근다');
  assert.ok(!/>부족</.test(anon), '로그인 전에 부족이라고 하면 안 된다');

  const unknown = render(null);
  assert.match(unknown, /확인 중/, '잔액을 모르면 확인 중으로 표시해야 한다');
  assert.ok(!/>부족</.test(unknown), '잔액을 모르는데 부족이라고 하면 안 된다');
  assert.match(unknown, /disabled/, '잔액을 모르면 교환을 열어두면 안 된다');

  const poor = render(500);
  assert.match(poor, />부족</, '잔액이 모자라면 부족으로 표시해야 한다');
  assert.match(poor, /disabled/, '잔액이 모자라면 버튼을 잠가야 한다');

  const rich = render(4500);
  assert.match(rich, />교환</, '잔액이 충분하면 교환으로 표시해야 한다');
  assert.ok(!/disabled/.test(rich), '잔액이 충분하면 버튼이 열려 있어야 한다');
});

test('잔액이 늦게 도착하면 카탈로그를 다시 그린다 (CLAW-202)', () => {
  const loadBalance = HTML.match(/async function loadBalance\(\)[\s\S]*?\n {6}\}/);
  assert.ok(loadBalance, 'loadBalance() 정의를 찾아야 한다');
  assert.match(loadBalance[0], /renderCatalog\(\)/, '잔액을 받은 뒤 버튼 상태를 다시 판정해야 한다');
});

// ── 광고 신청 창구 (CLAW-248) ─────────────────────────────────────────────
const CREATIVE_DIR = path.join(__dirname, '..', 'apps', 'user-web', 'creative');
const CREATIVE_HTML = fs.readFileSync(path.join(CREATIVE_DIR, 'index.html'), 'utf8');
const CREATIVE_JS = fs.readFileSync(path.join(CREATIVE_DIR, 'preview.js'), 'utf8');

test('신청 패널에 금액 안내·계좌·입력란·알림 고지가 모두 있다 (CLAW-248)', () => {
  for (const marker of ['unitPrice', 'estimateValue', 'depositAmount', 'depositorName', 'contact']) {
    assert.ok(CREATIVE_HTML.includes(`id="${marker}"`), `${marker} 입력·표시가 있어야 한다`);
  }
  // 계좌는 XP Details 배열로 쪼개 표시하므로 한 줄 문자열로 고정하지 않고 항목별로 본다.
  assert.match(CREATIVE_HTML, /우리은행/, '은행명을 표시해야 한다');
  assert.match(CREATIVE_HTML, /1002-157-849052/, '계좌번호를 표시해야 한다');
  assert.match(CREATIVE_HTML, /김태정/, '예금주를 표시해야 한다');
  assert.match(CREATIVE_HTML, /인정 노출/, '노출 1회당 차감 안내가 있어야 한다');
  // 집행 시작·소진 두 시점을 모두 알린다고 고지해야 한다.
  assert.match(CREATIVE_HTML, /시작될 때/, '집행 시작 알림 고지가 있어야 한다');
  assert.match(CREATIVE_HTML, /전부 소진되었을 때/, '소진 알림 고지가 있어야 한다');
});

// 광고주가 보는 화면에 사용자 적립액과의 관계를 드러내면 내부 정책이 새어 나간다.
// 주석·태그를 걷어낸 **보이는 문구**만 본다 — 마크업 단어("배경" 등)에 걸리면 검사가 무뎌진다.
test('신청 화면이 단가 산출 근거를 노출하지 않는다 (CLAW-248)', () => {
  const visible = CREATIVE_HTML
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  for (const banned of [/[0-9두세네]\s*배/, /적립[^.]{0,24}(배|비율|대비|절반)/, /마진/, /수수료율/]) {
    assert.doesNotMatch(visible, banned, `단가 산출 근거로 읽힐 문구(${banned})가 있으면 안 된다`);
  }
});

// 단가·상한은 정책값이다. 마크업이나 스크립트에 숫자를 박으면 정책 변경이 화면에 반영되지 않는다.
test('노출 단가·입금액 범위를 화면에 하드코딩하지 않는다 (rules §5)', () => {
  assert.match(CREATIVE_JS, /\/v1\/inquiries\/limits/, '단가를 서버에서 받아야 한다');
  assert.match(CREATIVE_JS, /pricePerImpressionKrw/, '서버가 준 단가 필드를 써야 한다');
  // 값을 못 받으면 기본값으로 때우지 않고 신청을 막는다.
  assert.match(CREATIVE_JS, /applySubmit\.disabled = true/, '단가를 못 받으면 제출을 막아야 한다');
  assert.doesNotMatch(CREATIVE_JS, /pricePerImpressionKrw\s*(=|\|\|)\s*\d/, '단가 폴백 상수를 두면 안 된다');
});

// 단가를 못 받으면 "1회당 —이 차감됩니다"로 굳고 금액을 넣어도 계산되지 않는다. 두 증상이
// 한 실패에서 나오는데 복구 수단이 수동 새로고침뿐이었다 — 배포 중 API 재시작 창에 페이지를
// 연 사람이 그대로 막혔다 (CLAW-248).
test('단가를 못 받으면 다시 받는 경로가 있다 (CLAW-248)', () => {
  assert.match(CREATIVE_JS, /RETRY_DELAYS_MS/, '첫 로드 재시도 간격이 있어야 한다');
  assert.match(CREATIVE_JS, /function ensureLimits\(\)/, '비어 있을 때 다시 받는 경로가 있어야 한다');
  // 패널을 열 때와 금액을 넣을 때 둘 다에서 복구를 시도한다.
  const toggle = CREATIVE_JS.slice(CREATIVE_JS.indexOf('function toggle()'), CREATIVE_JS.indexOf('function buildConfirmStage'));
  assert.match(toggle, /ensureLimits\(\)/, '패널을 열 때 다시 받아야 한다');
  const amount = CREATIVE_JS.slice(CREATIVE_JS.indexOf('function onAmountInput()'), CREATIVE_JS.indexOf('function validate()'));
  assert.match(amount, /ensureLimits\(\)/, '금액을 넣을 때 다시 받아야 한다');
  // 이미 받아 뒀으면 다시 부르지 않는다 — 조작마다 요청이 나가면 안 된다.
  assert.match(CREATIVE_JS, /if \(!limits && !loadingLimits\)/, '중복 요청을 막아야 한다');
});

test('신청 패널은 접힌 상태로 시작하고 열릴 때 마스코트 칸을 민다 (CLAW-248)', () => {
  assert.match(CREATIVE_HTML, /id="applyPanel"[^>]*inert/, '접힌 동안 inert여야 한다');
  // 마스코트 선택 칸은 문서상 신청 패널 뒤에 와야 밀림이 성립한다.
  assert.ok(
    CREATIVE_HTML.indexOf('id="applyPanel"') < CREATIVE_HTML.indexOf('class="mascot-panel"'),
    '신청 패널이 마스코트 칸보다 앞에 있어야 밀어낼 수 있다',
  );
  const css = fs.readFileSync(path.join(CREATIVE_DIR, 'preview.css'), 'utf8');
  assert.match(css, /\.apply-panel\s*\{[^}]*max-height:\s*0/, '접힘 상태는 max-height 0이어야 한다');
  assert.match(css, /\.apply-panel\.is-open\s*\{[^}]*max-height:/, '열림 상태가 정의돼야 한다');
  assert.match(css, /prefers-reduced-motion[^}]*\}[\s\S]*?\.apply-panel\s*\{\s*transition:\s*none/,
    '모션 축소 설정에서 전환을 꺼야 한다');
});

test('확인 모달은 광고판·금액·예금주·연락처를 되짚고 예를 기본 버튼으로 둔다 (CLAW-248)', () => {
  assert.match(CREATIVE_HTML, /<dialog[^>]*id="confirmDialog"/, '네이티브 dialog를 써야 한다');
  for (const id of ['confirmStage', 'confirmAmount', 'confirmImpressions', 'confirmDepositor', 'confirmContact']) {
    assert.ok(CREATIVE_HTML.includes(`id="${id}"`), `${id}를 모달에서 되짚어야 한다`);
  }
  assert.match(CREATIVE_HTML, /정말 제출하시겠어요\?/, '확인 질문이 있어야 한다');
  // 아니오는 보조, 예는 기본 버튼이라 더 눌리게 생겨야 한다.
  assert.match(CREATIVE_HTML, /id="confirmCancel"[^>]*class="ghost-button"/, '아니오는 보조 버튼이어야 한다');
  assert.match(CREATIVE_HTML, /id="confirmSubmit"[^>]*class="[^"]*primary-button[^"]*"[^>]*autofocus/,
    '예는 기본 버튼이고 포커스를 가져야 한다');
  // 광고판은 미리보기 무대를 복제한다 — 마크업을 두 벌 두면 [광고] 표기가 한쪽에서만 빠진다.
  assert.match(CREATIVE_JS, /previewStage\.cloneNode\(true\)/, '모달 광고판은 미리보기를 복제해야 한다');
});

test('신청 제출은 사실만 보내고 금액 판정은 서버 값을 쓴다 (rules §2)', () => {
  const submit = CREATIVE_JS.slice(CREATIVE_JS.indexOf('async function submit'), CREATIVE_JS.indexOf('function onConfirmClick'));
  assert.match(submit, /body\.estimatedImpressions/, '접수 결과는 서버 계산값으로 알려야 한다');
  // 화면이 계산한 노출 수·단가를 요청에 실으면 안 된다.
  const payload = CREATIVE_JS.slice(CREATIVE_JS.indexOf('const payload = {'), CREATIVE_JS.indexOf('return { ok: true, payload }'));
  for (const banned of ['estimatedImpressions', 'pricePerImpressionKrw', 'gross', 'userShare']) {
    assert.ok(!payload.includes(banned), `요청 본문에 ${banned}를 넣으면 안 된다`);
  }
});

// 안내는 제출 직전에 마지막으로 읽는 자리에 있어야 한다. 패널 위쪽에 두면 스크롤로 지나친다.
test('개인정보 안내가 확인 버튼 바로 위에 링크로 있다 (CLAW-250)', () => {
  const link = /<a href="\/legal\/inquiry-privacy\.html">/;
  assert.match(CREATIVE_HTML, link, '안내 링크가 있어야 한다');
  // 순서: 안내 링크 → 확인 버튼
  assert.ok(
    CREATIVE_HTML.search(link) < CREATIVE_HTML.indexOf('id="applySubmit"'),
    '안내 링크가 확인 버튼보다 위에 있어야 한다',
  );
  // 같은 탭에서 연다 (CLAW-224). target=_blank를 붙이지 않는다.
  const anchor = CREATIVE_HTML.slice(CREATIVE_HTML.search(link), CREATIVE_HTML.search(link) + 120);
  assert.doesNotMatch(anchor, /target=/, '법률 문서는 같은 탭에서 열어야 한다');

  // 화면이 말하는 보유기간과 안내문의 보유기간이 어긋나면 안 된다.
  const notice = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'legal', 'public', 'inquiry-privacy.html'), 'utf8');
  // 단위까지 함께 비교한다 — "개월"만 보면 년으로 바꿀 때 검사가 조용히 통과한다.
  const screenTerm = CREATIVE_HTML.match(/광고 종료 후 (\d+(?:년|개월))/);
  const noticeTerm = notice.match(/광고 집행 종료 후 <strong>(\d+(?:년|개월))<\/strong>/);
  assert.ok(screenTerm && noticeTerm, '양쪽에 보유기간이 적혀 있어야 한다');
  assert.strictEqual(screenTerm[1], noticeTerm[1], '화면과 안내문의 보유기간이 달라졌다');
});

// 광고주 안내는 이용자 처리방침과 별개 문서다. 이용자 수집 범위를 건드리지 않는다는 사실을
// 문서가 스스로 말해야, 나중에 "그때 재동의를 받았어야 하나"를 다시 따지지 않는다.
test('광고주 안내가 이용자 처리방침과의 관계를 밝힌다 (CLAW-250)', () => {
  const notice = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'legal', 'public', 'inquiry-privacy.html'), 'utf8');
  assert.match(notice, /광고를 신청하는 분에게만/, '적용 범위를 밝혀야 한다');
  assert.match(notice, /이용자의 수집 항목·목적·보유기간은 달라지지 않습니다/, '이용자 영향 없음을 밝혀야 한다');
  assert.match(notice, /분리된 저장소/, '이용자 기록과 분리 보관함을 밝혀야 한다');
  assert.match(notice, /접속 IP 주소와 기기 정보는 신청 기록에 저장하지 않습니다/, 'IP 미저장을 밝혀야 한다');
  assert.match(notice, /privacy-v4\.html/, '이용자 처리방침을 링크해야 한다');
});

test('허니팟은 사람 눈과 접근성 트리에서 모두 빠진다 (CLAW-248)', () => {
  assert.match(CREATIVE_HTML, /class="trap-field" aria-hidden="true"/, '허니팟은 aria-hidden이어야 한다');
  assert.match(CREATIVE_HTML, /id="company"[^>]*tabindex="-1"/, '허니팟은 탭 순서에서 빠져야 한다');
});

// 미리보기 SVG는 내부에서 p-*.png 조각을 참조한다. manifest에 적힌 SVG만 옮기면
// 마스코트가 빈 칸으로 뜬다 — 실제로 그렇게 깨졌다.
test('마스코트 SVG가 참조하는 조각 이미지가 모두 배포본에 있다 (CLAW-248)', () => {
  const assetsDir = path.join(CREATIVE_DIR, 'assets');
  const have = new Set(fs.readdirSync(assetsDir));
  const model = require(path.join(CREATIVE_DIR, 'preview-model.js'));
  for (const mascot of model.MASCOTS) {
    assert.ok(have.has(mascot.file), `manifest의 ${mascot.file}이 없다`);
  }
  for (const name of [...have].filter((n) => n.endsWith('.svg'))) {
    const svg = fs.readFileSync(path.join(assetsDir, name), 'utf8');
    for (const [, ref] of svg.matchAll(/(?:href|src)="([^":]+\.(?:png|svg|jpg))"/g)) {
      assert.ok(have.has(ref), `${name}이 참조하는 ${ref}가 없다`);
    }
  }
});

// 아트워크는 저장소 소스 라이선스(AGPL)가 아니라 © ClawAd다. 표시가 이 파일 하나에 걸려 있다.
test('아트워크 라이선스 표시를 함께 배포한다 (CLAW-248)', () => {
  const license = fs.readFileSync(path.join(CREATIVE_DIR, 'assets', 'LICENSE'), 'utf8');
  assert.match(license, /All Rights Reserved/i, '아트워크 권리 표시가 있어야 한다');
});

test('배포 이미지와 라우팅에 신청 페이지가 포함된다 (CLAW-248)', () => {
  const dir = path.join(__dirname, '..', 'apps', 'user-web');
  const dockerfile = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY apps\/user-web\/creative \/srv\/creative/, '배포 이미지에 페이지가 들어가야 한다');
  const caddy = fs.readFileSync(path.join(dir, 'Caddyfile'), 'utf8');
  assert.match(caddy, /@creativePage path[^\n]*\/creative\b/, '페이지 경로 규칙이 있어야 한다');
  assert.match(caddy, /@creativeAsset path \/creative\/assets\/\*/, '에셋 캐시 규칙이 있어야 한다');
  // 하루 캐시를 걸었더니 잘못된 CSP 헤더가 붙은 SVG가 그대로 하루 박혔다 (CLAW-248).
  // 서버를 고쳐도 이미 방문한 사람에게는 마스코트가 계속 안 떴다. 짧게 유지한다.
  const assetCache = caddy.match(/@creativeAsset[\s\S]{0,120}?Cache-Control "public, max-age=(\d+)"/);
  assert.ok(assetCache, '에셋 Cache-Control을 찾지 못했다');
  assert.ok(Number(assetCache[1]) <= 3600, `에셋 캐시가 너무 길다 (${assetCache[1]}초) — 잘못된 에셋이 그만큼 박힌다`);
});

// 마스코트는 <object>로 실린 SVG다. frame-ancestors를 'none'으로 조이면 같은 출처인데도
// 임베드가 막혀 마스코트만 사라지는데, 서버는 SVG에 200을 주므로 로그에 아무것도 남지 않는다.
// 실제로 그렇게 배포됐다 (CLAW-248). 되돌리는 변경을 여기서 잡는다.
test('CSP가 같은 출처 <object> 임베드를 막지 않는다 (CLAW-248)', () => {
  const caddy = fs.readFileSync(path.join(__dirname, '..', 'apps', 'user-web', 'Caddyfile'), 'utf8');
  const csp = caddy.match(/Content-Security-Policy "([^"]+)"/);
  assert.ok(csp, 'CSP 헤더가 있어야 한다');
  assert.match(csp[1], /frame-ancestors 'self'/, "frame-ancestors는 'self'여야 마스코트가 뜬다");
  // 교차 출처 프레이밍은 여전히 막혀 있어야 한다 — 완화의 범위는 우리 출처까지다.
  assert.doesNotMatch(csp[1], /frame-ancestors[^;]*\*/, '와일드카드 프레이밍을 허용하면 안 된다');
  assert.doesNotMatch(csp[1], /frame-ancestors[^;]*https?:\/\//, '외부 출처 프레이밍을 허용하면 안 된다');

  // 마스코트 SVG는 전부 외부 PNG 조각을 참조하므로 <img>로 바꿔 우회할 수 없다.
  // <img>의 secure static mode가 그 참조를 막는다.
  assert.match(CREATIVE_HTML, /<object[^>]*id="mascotObject"/, '마스코트는 object로 실려야 한다');
});

// ── 바탕화면 애드워드 상태 순환·상호작용 (CLAW-256) ─────────────────────────
// 게걸음 한 장면으로 고정이던 마스코트를 상태 기계로 바꿨다. 상태 표가 화면이 읽는 유일한
// 출처이므로, 에셋 이름이 어긋나면 그 상태만 조용히 빈 그림이 된다.
test('애드워드가 걷기·지휘·잠들기를 전이 에셋을 거쳐 순환한다 (CLAW-256)', () => {
  const table = HTML.slice(HTML.indexOf('const MASCOT_STATES = {'), HTML.indexOf('const MASCOT_DRAG_THRESHOLD'));
  const files = Object.fromEntries([...table.matchAll(/(\w+):\s*\{ file: '([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepStrictEqual(files, {
    walk: 'clawad-mini-crabwalk.svg',
    conduct: 'clawad-conducting.svg',
    collapse: 'clawad-collapsing.svg',
    sleep: 'clawad-sleeping.svg',
    wake: 'clawad-waking.svg',
    drag: 'clawad-react-drag.svg',
    double: 'clawad-react-double.svg',
  }, '상태별 에셋이 배포본의 파일 이름과 같아야 한다');

  // 걷다가 곧바로 자면 툭 끊긴다 — 잠들기·기상은 전이 에셋을 사이에 둔다.
  const cycle = table.match(/const MASCOT_CYCLE = \[([^\]]+)\]/);
  assert.ok(cycle, '순환 순서가 있어야 한다');
  assert.deepStrictEqual(
    cycle[1].split(',').map((s) => s.trim().replace(/'/g, '')),
    ['walk', 'conduct', 'walk', 'collapse', 'sleep', 'wake'],
    '걷기 → 지휘 → 걷기 → (잠들기 전이) → 잠들기 → (기상 전이) 순서여야 한다');

  // 제자리 동작인데 화면을 가로지르면 걷는 것으로 보인다.
  assert.match(table, /conduct:[^\n]*drift: false/, '지휘는 표류하지 않아야 한다');
  assert.match(table, /sleep:[^\n]*drift: false/, '잠들기는 표류하지 않아야 한다');
  assert.match(table, /walk:[^\n]*drift: true/, '걷기는 표류해야 한다');
  assert.match(HTML, /\.idle-float\.mascot-still \{ animation-play-state: paused; \}/,
    '표류는 멈추기만 하고 처음으로 되감지 않아야 한다');

  // 걷기가 머무는 상태보다 짧으면 제자리에서 상태만 바뀌는 그림이 된다.
  const ms = Object.fromEntries(
    [...table.matchAll(/(\w+):\s*\{ file: '[^']+',\s*label: '[^']*',\s*ms: (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.ok(ms.walk >= ms.conduct && ms.walk >= ms.sleep,
    `걷기(${ms.walk}ms)가 지휘(${ms.conduct}ms)·잠들기(${ms.sleep}ms)보다 짧으면 안 된다`);
  assert.strictEqual(ms.conduct, 10000, '지휘는 10초다');
  assert.strictEqual(ms.sleep, 10000, '잠들기는 10초다');
  // 전이는 에셋 안 애니메이션 길이만큼 재생해야 잘리지 않는다 (collapsing 1.6s / waking 2.6s).
  assert.strictEqual(ms.collapse, 1600, '잠들기 전이는 에셋 길이(1.6s)만큼 재생한다');
  assert.strictEqual(ms.wake, 2600, '기상 전이는 에셋 길이(2.6s)만큼 재생한다');
});

// 창이 떠 있어도 애드워드는 창 뒤에서 계속 보이므로 순환도 계속 돈다. 안내판은 감춰지니
// 회전을 멈춘다. 규칙이 서로 다르다는 점이 코드에 남아 있어야 한다.
test('마스코트 순환은 창 상태와 무관하다 (CLAW-256)', () => {
  const update = HTML.slice(HTML.indexOf('function updateIdleScene()'), HTML.indexOf('// ── 바탕화면 애드워드'));
  assert.ok(!/mascotTimer|startMascotCycle|setMascotState/.test(update),
    'updateIdleScene은 마스코트 순환을 건드리지 않아야 한다 — 창 뒤에서도 계속 돈다');
  assert.match(update, /stopNoticeRotation\(\)/, '안내판 회전만 창에 따라 멈춘다');
});

// 안내판이 마스코트와 같은 층에 있으면 표류·드래그에 딸려 다녀 누르려는 순간 도망간다.
test('안내판은 마스코트와 층이 갈려 제자리에 남는다 (CLAW-256)', () => {
  const scene = HTML.slice(HTML.indexOf('<div id="idleScene">'), HTML.indexOf('id="deskNotice"'));
  assert.match(scene, /class="idle-anchor" id="mascotAnchor"/, '드래그 오프셋을 받는 앵커가 있어야 한다');
  assert.match(scene, /class="idle-float" id="mascotFloat"/, '표류는 앵커 안쪽 층이 맡는다');
  const float = HTML.slice(HTML.indexOf('id="mascotFloat"'), HTML.indexOf('</div>', HTML.indexOf('id="mascotArt"')));
  assert.ok(!float.includes('deskNotice'), '안내판은 마스코트 층 밖에 있어야 한다');
  assert.match(HTML, /\.idle-anchor \{ transform: translate\(var\(--drop-x, 0px\), var\(--drop-y, 0px\)\); \}/,
    '놓아둔 자리는 앵커의 transform으로만 유지한다');
});

test('애드워드를 끌면 매달리고 더블클릭하면 반응한다 (CLAW-256)', () => {
  const bind = HTML.slice(HTML.indexOf('function bindMascotEvents()'), HTML.indexOf('buildDocumentWindows();'));
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick']) {
    assert.ok(bind.includes(`'${ev}'`), `${ev} 처리가 있어야 한다`);
  }
  assert.match(bind, /setPointerCapture/, '커서가 마스코트 밖으로 나가도 계속 따라와야 한다');
  assert.match(bind, /setMascotState\('drag'\)/, '끌면 매달리기로 바꿔야 한다');
  assert.match(bind, /setMascotState\('double'\)/, '더블클릭은 하트로 반응해야 한다');
  // 끌어놓은 손짓은 더블클릭으로도 잡힌다 — 이동 거리로 가른다.
  assert.match(HTML, /const MASCOT_DRAG_THRESHOLD = \d+;/, '드래그 판정 임계값이 있어야 한다');
  assert.match(bind, /if \(mascotDragged\) return;/, '방금 끌었으면 하트를 띄우지 않아야 한다');
  // 만졌더니 바로 잠드는 그림이 되면 안 된다.
  assert.match(bind, /if \(mascotDragged\) startMascotCycle\(\);/, '놓으면 순환을 처음부터 다시 센다');
  assert.match(HTML, /function startMascotCycle\(\)[\s\S]{0,400}mascotIndex = 0;/, '순환 재시작은 항상 걷기부터다');
  // pointerdown에서 preventDefault를 부르면 브라우저에 따라 뒤따르는 dblclick이 사라진다.
  assert.ok(!/pointerdown[\s\S]{0,700}?event\.preventDefault\(\)/.test(bind),
    'pointerdown에서 preventDefault를 부르면 더블클릭을 잃는다');
  assert.match(HTML, /\.idle-float \{[^}]*touch-action: none;[^}]*\}/, '터치에서도 끌 수 있어야 한다');
});

// 움직임에 민감한 사용자에게는 자동 순환·표류를 멈춘다. 손으로 만진 반응까지 없애면
// 눌렀는데 아무 일도 일어나지 않는 화면이 된다.
test('움직임 최소화에서는 자동 순환만 멈춘다 (CLAW-256)', () => {
  assert.match(HTML, /const reducedMotion = window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\);/,
    '설정을 읽어야 한다');
  const cycle = HTML.slice(HTML.indexOf('function startMascotCycle()'), HTML.indexOf('function bindMascotEvents()'));
  assert.match(cycle, /if \(reducedMotion\.matches\) return;/, '자동 순환을 시작하지 않아야 한다');
  assert.match(cycle, /setMascotState\('walk'\)[\s\S]{0,200}reducedMotion\.matches/,
    '순환을 멈추더라도 걷기 그림은 남아야 한다');
  const bind = HTML.slice(HTML.indexOf('function bindMascotEvents()'), HTML.indexOf('buildDocumentWindows();'));
  assert.ok(!/reducedMotion\.matches/.test(bind), '드래그·더블클릭 반응은 설정과 무관하게 남는다');
});

// 몸통 좌표는 모든 상태가 같지만 캔버스가 다르면 고정 CSS 박스 안에서 그 상태만 작게 그려진다.
// 게걸음만 넓혀 놓았던 탓에 상태를 갈아끼울 때 크기가 튀었다 (CLAW-253 → CLAW-256).
test('마스코트 상태 에셋이 같은 캔버스를 쓴다 (CLAW-256)', () => {
  const dir = path.join(__dirname, '..', 'apps', 'user-web', 'creative', 'assets');
  const table = HTML.slice(HTML.indexOf('const MASCOT_STATES = {'), HTML.indexOf('const MASCOT_DRAG_THRESHOLD'));
  const files = [...table.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length >= 7, '상태 에셋을 찾지 못했다');

  const boxes = new Map();
  for (const f of files) {
    const svg = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '');
    const vb = svg.match(/viewBox="([^"]+)"/);
    assert.ok(vb, `${f}에 viewBox가 있어야 한다`);
    boxes.set(f, vb[1]);
  }
  // 매달리기만 스윙 때 꼬리가 왼쪽으로 벗어나 더 넓은 캔버스가 필요하다. 나머지는 한 값이어야 한다.
  const others = [...boxes].filter(([f]) => f !== 'clawad-react-drag.svg').map(([, vb]) => vb);
  assert.strictEqual(new Set(others).size, 1,
    `매달리기를 뺀 상태는 캔버스가 하나여야 한다: ${JSON.stringify([...boxes])}`);

  // 예외인 매달리기는 넓어진 비율만큼 CSS 박스를 넓혀 몸통 크기를 맞춘다.
  const dragW = Number(boxes.get('clawad-react-drag.svg').split(' ')[2]);
  const baseW = Number(others[0].split(' ')[2]);
  if (dragW !== baseW) {
    assert.match(HTML, new RegExp(`\\.idle-mascot\\[data-mascot-state='drag'\\][^}]*\\* ${dragW} / ${baseW}`),
      `매달리기 캔버스(${dragW})가 기본(${baseW})과 다르면 그 비율로 박스를 보정해야 한다`);
  }

  // 생성기와 배포본이 갈라지면 에셋을 다시 만들어도 화면은 그대로다.
  const build = fs.readFileSync(path.join(__dirname, '..', 'mascot', 'theme-build.js'), 'utf8');
  assert.match(build, new RegExp(`const DEFAULT_VB = '${others[0]}';`),
    '생성기의 기본 캔버스가 배포된 에셋과 같아야 한다');
});
