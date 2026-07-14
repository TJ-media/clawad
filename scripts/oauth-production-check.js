'use strict';

const apiOrigin = new URL(process.argv[2] || '');
const returnTarget = new URL(process.argv[3] || '');
if (apiOrigin.protocol !== 'https:' || apiOrigin.pathname !== '/') throw new Error('첫 인자는 경로 없는 HTTPS API origin이어야 합니다.');
if (returnTarget.protocol !== 'https:') throw new Error('두 번째 인자는 HTTPS return target이어야 합니다.');

const expectations = {
  google: { host: 'accounts.google.com', scope: 'openid' },
  kakao: { host: 'kauth.kakao.com', scope: 'openid' },
  naver: { host: 'nid.naver.com', scope: null },
};

async function check(provider, expected) {
  const response = await fetch(new URL(`/v1/auth/social/${provider}/start`, apiOrigin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: 'LOGIN', returnTarget: returnTarget.toString() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${provider} 시작 확인 실패 (${response.status})`);
  const body = await response.json();
  const authorizationUrl = new URL(body.authorizationUrl);
  if (authorizationUrl.hostname !== expected.host) throw new Error(`${provider} authorization host 불일치`);
  const callback = authorizationUrl.searchParams.get('redirect_uri');
  if (callback !== new URL(`/v1/auth/social/${provider}/callback`, apiOrigin).toString()) throw new Error(`${provider} callback 불일치`);
  if (authorizationUrl.searchParams.get('scope') !== expected.scope) throw new Error(`${provider} 최소 scope 불일치`);
  if (authorizationUrl.searchParams.has('client_secret') || authorizationUrl.searchParams.has('code')) {
    throw new Error(`${provider} authorization URL에 민감정보가 포함됐습니다.`);
  }
}

Promise.all(Object.entries(expectations).map(([provider, expected]) => check(provider, expected)))
  .then(() => console.log('세 OAuth 공급자 운영 시작 설정 확인 완료'))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
