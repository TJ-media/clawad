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

// 잔액 응답이 상품 목록보다 늦게 오면 balance가 0인 채로 카탈로그가 그려져
// 전 상품이 "부족"으로 굳었다 (CLAW-202, 2026-08-14 알파 리허설에서 4500P 계정으로 발견).
// 문자열 검사로는 못 잡아서 card()를 실제로 실행한다.
test('잔액 미확인 상태를 포인트 부족으로 렌더하지 않는다 (CLAW-202)', () => {
  const source = HTML.match(/function card\(p, anchor\) \{[\s\S]*?\n {6}\}/);
  assert.ok(source, 'card() 정의를 찾아야 한다');
  const build = new Function('balance', 'esc', `${source[0]}\nreturn card;`);
  const render = (balance) => build(balance, String)({ id: 'p1', brand: 'B', name: 'N', pointCost: 1500, category: 'CAFE' }, false);

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
