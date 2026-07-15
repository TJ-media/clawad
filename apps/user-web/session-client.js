'use strict';

(function exposeSessionClient(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClawadSessionClient = api;
})(typeof globalThis === 'object' ? globalThis : window, function buildSessionClient() {
  function responseError(response, body) {
    return Object.assign(new Error(body.error || String(response.status)), { body, status: response.status });
  }

  async function parseBody(response) {
    return response.json().catch(() => ({}));
  }

  function createSessionClient({ baseUrl, fetchImpl, onSessionExpired = () => {} }) {
    let accessToken = null;
    let generation = 0;
    let refreshFlight = null;

    function sessionChangedError() {
      return Object.assign(new Error('SESSION_CHANGED'), { code: 'SESSION_CHANGED' });
    }

    function setAccessToken(value) {
      generation += 1;
      accessToken = typeof value === 'string' && value ? value : null;
    }

    function clearAccessToken() {
      generation += 1;
      accessToken = null;
    }

    function expireSession(error, expectedGeneration) {
      if (generation !== expectedGeneration) return;
      const hadSession = Boolean(accessToken);
      clearAccessToken();
      if (hadSession) onSessionExpired(error);
    }

    async function send(path, opts, requestToken) {
      let response;
      try {
        response = await fetchImpl(baseUrl + path, {
          ...opts,
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(requestToken ? { Authorization: 'Bearer ' + requestToken } : {}),
            ...(opts.headers || {}),
          },
        });
      } catch (cause) {
        throw Object.assign(new Error('NETWORK_UNAVAILABLE'), { cause, code: 'NETWORK_UNAVAILABLE' });
      }
      const body = await parseBody(response);
      return { response, body };
    }

    function refreshAccessToken(expectedGeneration = generation) {
      if (generation !== expectedGeneration) return Promise.reject(sessionChangedError());
      if (refreshFlight && refreshFlight.generation === expectedGeneration) return refreshFlight.promise;
      const promise = (async () => {
        const { response, body } = await send('/v1/auth/refresh', { method: 'POST', body: '{}' }, null);
        if (generation !== expectedGeneration) throw sessionChangedError();
        if (!response.ok) throw responseError(response, body);
        if (typeof body.accessToken !== 'string' || !body.accessToken) throw new Error('REFRESH_RESPONSE_INVALID');
        accessToken = body.accessToken;
        return body.accessToken;
      })().catch((error) => {
        if (error.code !== 'SESSION_CHANGED') expireSession(error, expectedGeneration);
        throw error;
      }).finally(() => {
        if (refreshFlight && refreshFlight.promise === promise) refreshFlight = null;
      });
      refreshFlight = { generation: expectedGeneration, promise };
      return promise;
    }

    async function request(path, opts = {}, allowRefresh = true) {
      const requestGeneration = generation;
      const requestToken = accessToken;
      const { response, body } = await send(path, opts, requestToken);
      if (generation !== requestGeneration) throw sessionChangedError();
      if (response.status === 401 && requestToken && path !== '/v1/auth/refresh') {
        if (!allowRefresh) {
          const error = responseError(response, body);
          if (accessToken !== requestToken) throw sessionChangedError();
          expireSession(error, requestGeneration);
          throw error;
        }
        if (accessToken === requestToken) await refreshAccessToken(requestGeneration);
        if (generation !== requestGeneration) throw sessionChangedError();
        return request(path, opts, false);
      }
      if (!response.ok) throw responseError(response, body);
      return body;
    }

    return { request, refreshAccessToken, setAccessToken, clearAccessToken };
  }

  return { createSessionClient };
});
