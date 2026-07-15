'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createSessionClient } = require('../apps/user-web/session-client');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('API 401이면 refresh 후 새 access token으로 원 요청을 한 번 재시도한다', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, authorization: opts.headers.Authorization });
    if (url.endsWith('/v1/auth/refresh')) return response(200, { accessToken: 'new-token' });
    if (opts.headers.Authorization === 'Bearer old-token') return response(401, { error: 'UNAUTHORIZED' });
    return response(200, { confirmedPoints: 10 });
  };
  const client = createSessionClient({ baseUrl: 'https://api.test', fetchImpl });
  client.setAccessToken('old-token');

  assert.deepStrictEqual(await client.request('/v1/rewards'), { confirmedPoints: 10 });
  assert.deepStrictEqual(calls.map((call) => call.authorization), ['Bearer old-token', undefined, 'Bearer new-token']);
});

test('동시 401은 refresh single-flight를 공유하고 각 원 요청만 재시도한다', async () => {
  let refreshCalls = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/v1/auth/refresh')) {
      refreshCalls += 1;
      await refreshGate;
      return response(200, { accessToken: 'new-token' });
    }
    if (opts.headers.Authorization === 'Bearer old-token') return response(401, { error: 'UNAUTHORIZED' });
    return response(200, { ok: true });
  };
  const client = createSessionClient({ baseUrl: 'https://api.test', fetchImpl });
  client.setAccessToken('old-token');
  const requests = [client.request('/v1/rewards'), client.request('/v1/rewards/products')];
  await new Promise((resolve) => setImmediate(resolve));
  releaseRefresh();

  assert.deepStrictEqual(await Promise.all(requests), [{ ok: true }, { ok: true }]);
  assert.strictEqual(refreshCalls, 1);
});

test('refresh 만료 시 메모리 토큰을 지우고 세션 만료를 한 번만 알린다', async () => {
  let expiredCalls = 0;
  let protectedCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/auth/refresh')) return response(401, { error: 'REFRESH_REVOKED' });
    protectedCalls += 1;
    return response(401, { error: 'UNAUTHORIZED' });
  };
  const client = createSessionClient({
    baseUrl: 'https://api.test', fetchImpl,
    onSessionExpired: () => { expiredCalls += 1; },
  });
  client.setAccessToken('old-token');

  const settled = await Promise.allSettled([
    client.request('/v1/rewards'),
    client.request('/v1/rewards/products'),
  ]);
  assert.ok(settled.every((result) => result.status === 'rejected'));
  assert.strictEqual(expiredCalls, 1);
  assert.strictEqual(protectedCalls, 2);
});

test('재시도한 요청도 401이면 무한 refresh 없이 안전하게 세션을 종료한다', async () => {
  let refreshCalls = 0;
  let expiredCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/auth/refresh')) {
      refreshCalls += 1;
      return response(200, { accessToken: 'new-token' });
    }
    return response(401, { error: 'UNAUTHORIZED' });
  };
  const client = createSessionClient({ baseUrl: 'https://api.test', fetchImpl, onSessionExpired: () => { expiredCalls += 1; } });
  client.setAccessToken('old-token');

  await assert.rejects(client.request('/v1/rewards'), (error) => error.status === 401);
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(expiredCalls, 1);
});

test('오프라인 fetch 실패는 복구 UI가 구분할 수 있는 오류 코드로 전달한다', async () => {
  const client = createSessionClient({
    baseUrl: 'https://api.test',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  client.setAccessToken('token');
  await assert.rejects(client.request('/v1/rewards'), (error) => error.code === 'NETWORK_UNAVAILABLE');
});

test('이전 세션의 늦은 401은 새 로그인 토큰으로 원 요청을 재실행하지 않는다', async () => {
  let releaseOldRequest;
  const oldRequestGate = new Promise((resolve) => { releaseOldRequest = resolve; });
  const authorizations = [];
  const fetchImpl = async (url, opts) => {
    authorizations.push(opts.headers.Authorization);
    if (url.endsWith('/v1/rewards/redeem')) {
      await oldRequestGate;
      return response(401, { error: 'UNAUTHORIZED' });
    }
    return response(200, {});
  };
  const client = createSessionClient({ baseUrl: 'https://api.test', fetchImpl });
  client.setAccessToken('old-user-token');
  const oldRequest = client.request('/v1/rewards/redeem', { method: 'POST', body: '{}' });
  client.clearAccessToken();
  client.setAccessToken('new-user-token');
  releaseOldRequest();

  await assert.rejects(oldRequest, (error) => error.code === 'SESSION_CHANGED');
  assert.deepStrictEqual(authorizations, ['Bearer old-user-token']);
});

test('로그아웃 뒤 완료된 이전 refresh는 access token을 되살리지 않는다', async () => {
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const authorizations = [];
  const fetchImpl = async (url, opts) => {
    authorizations.push(opts.headers.Authorization);
    if (url.endsWith('/v1/auth/refresh')) {
      await refreshGate;
      return response(200, { accessToken: 'stale-refreshed-token' });
    }
    return response(200, { ok: true });
  };
  const client = createSessionClient({ baseUrl: 'https://api.test', fetchImpl });
  client.setAccessToken('old-token');
  const refreshing = client.refreshAccessToken();
  client.clearAccessToken();
  client.setAccessToken('new-token');
  releaseRefresh();

  await assert.rejects(refreshing, (error) => error.code === 'SESSION_CHANGED');
  await client.request('/v1/rewards');
  assert.strictEqual(authorizations.at(-1), 'Bearer new-token');
});

test('이전 세션의 늦은 refresh 실패는 새 로그인 세션을 만료시키지 않는다', async () => {
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let expiredCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/v1/auth/refresh')) {
      await refreshGate;
      return response(401, { error: 'INVALID_REFRESH_TOKEN' });
    }
    return response(200, { authorization: opts.headers.Authorization });
  };
  const client = createSessionClient({ baseUrl: 'https://api.test', fetchImpl, onSessionExpired: () => { expiredCalls += 1; } });
  client.setAccessToken('old-token');
  const refreshing = client.refreshAccessToken();
  client.setAccessToken('new-token');
  releaseRefresh();

  await assert.rejects(refreshing, (error) => error.code === 'SESSION_CHANGED');
  assert.deepStrictEqual(await client.request('/v1/rewards'), { authorization: 'Bearer new-token' });
  assert.strictEqual(expiredCalls, 0);
});

test('이전 access token 재시도의 늦은 401은 같은 세션의 최신 refresh token을 지우지 않는다', async () => {
  let refreshCalls = 0;
  let releaseFirstRetry;
  let signalFirstRetry;
  const firstRetryGate = new Promise((resolve) => { releaseFirstRetry = resolve; });
  const firstRetryStarted = new Promise((resolve) => { signalFirstRetry = resolve; });
  let expiredCalls = 0;
  const fetchImpl = async (url, opts) => {
    const authorization = opts.headers.Authorization;
    if (url.endsWith('/v1/auth/refresh')) {
      refreshCalls += 1;
      return response(200, { accessToken: `token-${refreshCalls}` });
    }
    if (url.endsWith('/first')) {
      if (authorization === 'Bearer token-0') return response(401, { error: 'UNAUTHORIZED' });
      if (authorization === 'Bearer token-1') {
        signalFirstRetry();
        await firstRetryGate;
        return response(401, { error: 'UNAUTHORIZED' });
      }
    }
    if (url.endsWith('/second') && authorization === 'Bearer token-1') return response(401, { error: 'UNAUTHORIZED' });
    return response(200, { authorization });
  };
  const client = createSessionClient({ baseUrl: 'https://api.test', fetchImpl, onSessionExpired: () => { expiredCalls += 1; } });
  client.setAccessToken('token-0');
  const first = client.request('/first');
  await firstRetryStarted;
  assert.deepStrictEqual(await client.request('/second'), { authorization: 'Bearer token-2' });
  releaseFirstRetry();

  await assert.rejects(first, (error) => error.code === 'SESSION_CHANGED');
  assert.deepStrictEqual(await client.request('/probe'), { authorization: 'Bearer token-2' });
  assert.strictEqual(refreshCalls, 2);
  assert.strictEqual(expiredCalls, 0);
});
