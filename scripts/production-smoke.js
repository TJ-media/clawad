'use strict';

const baseUrl = process.argv[2] || process.env.CLAWAD_API_URL;
if (!baseUrl) throw new Error('HTTPS API 주소를 인자로 전달하세요.');
const origin = new URL(baseUrl);
if (origin.protocol !== 'https:' || origin.pathname !== '/') {
  throw new Error('API 주소는 경로가 없는 HTTPS origin이어야 합니다.');
}

async function check(pathname) {
  const response = await fetch(new URL(pathname, origin), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${pathname} 상태 확인 실패 (${response.status})`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error(`${pathname} 응답이 준비 상태가 아닙니다.`);
}

Promise.all([check('/health/live'), check('/health/ready')])
  .then(() => console.log(`운영 API 상태 확인 완료: ${origin.origin}`))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
