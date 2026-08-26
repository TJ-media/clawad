(function spiderDealProviderModule(root, factory) {
  const api = factory(root && root.ClawadSpider, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClawadSpiderDealProvider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function spiderDealProviderFactory(defaultEngine, root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 1000;
  const DEFAULT_MAX_NODES = 100000;
  const WATCHDOG_MARGIN_MS = 100;
  const RECENT_SEED_LIMIT = 32;

  function checksumFor(state) {
    const cards = (piles) => (Array.isArray(piles) ? piles : []).map((pile) => (Array.isArray(pile) ? pile : [])
      .map((card) => `${card?.id || ''}:${card?.suit || ''}:${card?.rank || ''}:${card?.faceUp ? 1 : 0}`)
      .join(',')).join('|');
    const source = `${state?.difficulty || ''}/${cards(state?.tableau)}/${cards([state?.stock])}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function isUnsignedSeed(value) {
    return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  }

  function positiveInteger(value) {
    return Number.isInteger(value) && value > 0;
  }

  function unavailableError() {
    const error = new Error('검증된 스파이더 딜을 사용할 수 없습니다.');
    error.code = 'VERIFIED_DEALS_UNAVAILABLE';
    return error;
  }

  function requestError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function createSpiderDealProvider(options = {}) {
    const engine = options.engine || defaultEngine;
    const WorkerCtor = options.WorkerCtor || root?.Worker;
    const workerUrl = options.workerUrl || './spider-solver-worker.js';
    const timeoutMs = positiveInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxNodes = positiveInteger(options.maxNodes) ? options.maxNodes : DEFAULT_MAX_NODES;
    const seedSource = typeof options.seeds === 'function' ? options.seeds : null;
    const verifiedDeals = options.verifiedDeals || null;
    const recentSeeds = new Map();
    let current = null;
    let requestSequence = 0;
    let fallbackSeed = Date.now() >>> 0;

    function nextSeed() {
      const seed = seedSource ? seedSource() : undefined;
      if (isUnsignedSeed(seed)) return seed;
      fallbackSeed = (fallbackSeed + 1) >>> 0;
      return fallbackSeed;
    }

    function rememberSeed(difficulty, seed) {
      const recent = recentSeeds.get(difficulty) || [];
      recent.push(seed);
      if (recent.length > RECENT_SEED_LIMIT) recent.splice(0, recent.length - RECENT_SEED_LIMIT);
      recentSeeds.set(difficulty, recent);
    }

    function availablePool(difficulty) {
      const pools = verifiedDeals?.difficulties || verifiedDeals;
      const entries = pools && pools[difficulty];
      if (!Array.isArray(entries) || !engine || typeof engine.dealSpiderFromSeed !== 'function') return [];

      const seenSeeds = new Set();
      return entries.reduce((valid, entry) => {
        if (!entry || !isUnsignedSeed(entry.seed) || !positiveInteger(entry.solutionLength)
          || typeof entry.checksum !== 'string' || seenSeeds.has(entry.seed)) return valid;
        const state = engine.dealSpiderFromSeed(difficulty, entry.seed);
        if (!state || checksumFor(state) !== entry.checksum) return valid;
        seenSeeds.add(entry.seed);
        valid.push({ seed: entry.seed, state });
        return valid;
      }, []);
    }

    function verifiedFallback(difficulty) {
      const valid = availablePool(difficulty);
      if (valid.length === 0) return null;
      const recent = new Set(recentSeeds.get(difficulty) || []);
      const alternatives = valid.filter((deal) => !recent.has(deal.seed));
      const selected = alternatives.length > 0 ? alternatives[0] : valid[0];
      rememberSeed(difficulty, selected.seed);
      return {
        state: selected.state,
        seed: selected.seed,
        verification: 'verified-pool',
        solverMs: 0,
      };
    }

    function clearRequestTimers(request) {
      if (request.timeoutTimer) clearTimeout(request.timeoutTimer);
      if (request.watchdogTimer) clearTimeout(request.watchdogTimer);
      request.timeoutTimer = null;
      request.watchdogTimer = null;
    }

    function terminateRequest(request) {
      if (!request || request.terminated) return;
      request.terminated = true;
      try {
        request.worker.terminate();
      } catch (_) {
        // Worker 종료 실패도 새 요청을 막거나 검증 풀 후퇴를 막지 않는다.
      }
    }

    function finishWithFallback(request) {
      if (current !== request) return;
      clearRequestTimers(request);
      terminateRequest(request);
      current = null;
      const fallback = verifiedFallback(request.difficulty);
      if (fallback) request.resolve(fallback);
      else request.reject(unavailableError());
    }

    function finishLive(request, result) {
      if (current !== request) return;
      clearRequestTimers(request);
      terminateRequest(request);
      current = null;
      rememberSeed(request.difficulty, request.seed);
      const elapsedMs = Number.isFinite(result.elapsedMs) ? Math.max(0, result.elapsedMs) : Date.now() - request.startedAt;
      request.resolve({
        state: engine.dealSpiderFromSeed(request.difficulty, request.seed),
        seed: request.seed,
        verification: 'live',
        solverMs: elapsedMs,
      });
    }

    function isReplayVerified(request, result) {
      if (!result || result.status !== 'solved' || !Array.isArray(result.actions)
        || !engine || typeof engine.replaySpiderActions !== 'function') return false;
      try {
        return engine.replaySpiderActions(request.difficulty, request.seed, result.actions).won === true;
      } catch (_) {
        return false;
      }
    }

    function supersede(code) {
      if (!current) return;
      const request = current;
      clearRequestTimers(request);
      terminateRequest(request);
      current = null;
      request.reject(requestError(code));
    }

    function next(difficulty) {
      supersede('REQUEST_SUPERSEDED');
      const requestId = ++requestSequence;
      const seed = nextSeed();

      return new Promise((resolve, reject) => {
        if (!engine || typeof engine.dealSpiderFromSeed !== 'function' || typeof WorkerCtor !== 'function') {
          const fallback = verifiedFallback(difficulty);
          if (fallback) resolve(fallback);
          else reject(unavailableError());
          return;
        }

        let worker;
        try {
          worker = new WorkerCtor(workerUrl);
        } catch (_) {
          const fallback = verifiedFallback(difficulty);
          if (fallback) resolve(fallback);
          else reject(unavailableError());
          return;
        }

        const request = {
          id: requestId,
          difficulty,
          seed,
          worker,
          resolve,
          reject,
          startedAt: Date.now(),
          timeoutTimer: null,
          watchdogTimer: null,
          terminated: false,
        };
        current = request;
        worker.onmessage = (event) => {
          const message = event && event.data;
          if (current !== request || !message || message.type !== 'result' || message.requestId !== request.id) return;
          if (isReplayVerified(request, message.result)) finishLive(request, message.result);
          else finishWithFallback(request);
        };
        worker.onerror = () => finishWithFallback(request);
        request.timeoutTimer = setTimeout(() => finishWithFallback(request), timeoutMs);
        request.watchdogTimer = setTimeout(() => finishWithFallback(request), timeoutMs + WATCHDOG_MARGIN_MS);

        try {
          worker.postMessage({
            type: 'solve',
            requestId,
            difficulty,
            seed,
            timeoutMs,
            maxNodes,
          });
        } catch (_) {
          finishWithFallback(request);
        }
      });
    }

    function cancel() {
      supersede('REQUEST_CANCELLED');
    }

    function destroy() {
      supersede('REQUEST_DESTROYED');
    }

    return { next, cancel, destroy };
  }

  return { createSpiderDealProvider, checksumFor };
});
