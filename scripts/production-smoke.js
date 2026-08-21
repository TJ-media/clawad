'use strict';

const baseUrl = process.argv[2] || process.env.CLAWAD_API_URL;
const webUrl = process.argv[3] || process.env.CLAWAD_WEB_URL;
const releaseSha = process.argv[4] || process.env.RELEASE_SHA;
if (!baseUrl || !webUrl || !/^[0-9a-f]{40}$/.test(releaseSha || '')) {
  throw new Error('HTTPS API·user-web 주소와 40자리 release SHA를 전달하세요.');
}
const origin = new URL(baseUrl);
const webOrigin = new URL(webUrl);
if (origin.protocol !== 'https:' || origin.pathname !== '/' || webOrigin.protocol !== 'https:' || webOrigin.pathname !== '/') {
  throw new Error('API 주소는 경로가 없는 HTTPS origin이어야 합니다.');
}

async function check(pathname) {
  const response = await fetch(new URL(pathname, origin), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${pathname} 상태 확인 실패 (${response.status})`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error(`${pathname} 응답이 준비 상태가 아닙니다.`);
}

async function checkWeb(pathname, expectedContent) {
  const response = await fetch(new URL(pathname, webOrigin), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`user-web ${pathname} 상태 확인 실패 (${response.status})`);
  if (response.headers.get('x-clawad-release') !== releaseSha) throw new Error(`user-web ${pathname} release SHA 불일치`);
  if (pathname !== '/healthz' && response.headers.get('cache-control') !== 'no-store') {
    throw new Error(`user-web ${pathname} 교차 release cache 방지 헤더가 없습니다.`);
  }
  if (pathname === '/') {
    const requiredHeaders = {
      'content-security-policy': ['frame-ancestors', 'connect-src'],
      'strict-transport-security': ['max-age='],
      'x-content-type-options': ['nosniff'],
      'referrer-policy': ['no-referrer'],
      'permissions-policy': ['camera=()', 'microphone=()', 'geolocation=()'],
    };
    for (const [name, markers] of Object.entries(requiredHeaders)) {
      const value = response.headers.get(name) || '';
      if (markers.some((marker) => !value.includes(marker))) throw new Error(`user-web ${name} 보안 헤더가 유효하지 않습니다.`);
    }
  }
  const body = await response.text();
  if (expectedContent && !body.includes(expectedContent)) throw new Error(`user-web ${pathname} 필수 자산이 없습니다.`);
  return response;
}

async function checkPolicyAndLegal() {
  const policyResponse = await fetch(new URL('/v1/policy', webOrigin), { signal: AbortSignal.timeout(10_000) });
  const policy = await policyResponse.json();
  if (!policyResponse.ok || !Number.isInteger(policy.policyVersion)
    || !Number.isInteger(policy.reward?.minimumRedemptionPoints) || !String(policy.releaseStage || '').trim()) {
    throw new Error('user-web 공개 정책 응답이 유효하지 않습니다.');
  }
  const legalResponse = await fetch(new URL('/v1/legal/documents', webOrigin), { signal: AbortSignal.timeout(10_000) });
  const legal = await legalResponse.json();
  if (!legalResponse.ok || !Array.isArray(legal.documents) || legal.documents.length !== 2) {
    throw new Error('user-web 법률 문서 응답이 유효하지 않습니다.');
  }
  const urls = [...legal.documents.map((document) => document.url), legal.privacyContactUrl, legal.removalGuideUrl];
  // 활성 문서가 링크하는 구버전도 함께 확인한다. 각 개정 안내가 직전 버전을 링크하므로
  // 구버전 파일을 배치하지 않으면 활성 문서만 검사하는 스모크는 통과하고 그 링크만 404가 된다.
  const linkedVersions = new Set();
  for (const value of urls) {
    const target = new URL(value);
    if (target.origin !== webOrigin.origin) throw new Error('법률 문서 URL이 user-web 운영 도메인과 다릅니다.');
    const response = await fetch(target, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`법률 문서 공개 확인 실패: ${target.pathname}`);
    const body = await response.text();
    if (body.length < 40 || /외부 공개 금지|외부 공개 전 필수|\[미확정|TODO|PLACEHOLDER/i.test(body)) {
      throw new Error(`법률 문서가 승인된 공개본이 아닙니다: ${target.pathname}`);
    }
    for (const match of body.matchAll(/href="((?:privacy|terms)-v\d+\.html)"/g)) {
      linkedVersions.add(new URL(match[1], target).href);
    }
  }
  for (const value of linkedVersions) {
    if (urls.includes(value)) continue;
    const response = await fetch(value, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`활성 법률 문서가 링크한 구버전이 공개되지 않았습니다: ${new URL(value).pathname}`);
    }
  }
}

// games.js는 HTML 속성이 아니라 JS가 불러온다(창을 처음 열 때 지연 로드). 그래서 페이지
// 자산 검사(test/user-web.test.js의 src="./…" ↔ Dockerfile COPY 대조)가 잡지 못한다 —
// 배포 목록에서 빠져도 로컬·CI는 전부 통과하고 배포본에서만 404가 난다(CLAW-203과 같은 모양).
// 여기서 직접 받아본다.
Promise.all([
  check('/health/live'),
  check('/health/ready'),
  checkWeb('/', 'session-client.js'),
  checkWeb('/session-client.js', 'ClawadSessionClient'),
  checkWeb('/games.js', 'ClawadGames'),
  checkPolicyAndLegal(),
])
  .then(() => console.log(`운영 API·user-web 상태 확인 완료: ${origin.origin}, ${webOrigin.origin}`))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
