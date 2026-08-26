'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const spider = require('../apps/user-web/spider-solitaire.js');
const {
  createSpiderDealProvider,
  checksumFor,
} = require('../apps/user-web/spider-deal-provider.js');

function fixedSeedSource(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

function fakeWorkerReturning(result) {
  function FakeWorker() {
    this.terminated = false;
    FakeWorker.instances.push(this);
  }
  FakeWorker.instances = [];
  FakeWorker.prototype.postMessage = function postMessage(request) {
    queueMicrotask(() => {
      if (!this.terminated && typeof this.onmessage === 'function') {
        this.onmessage({ data: { type: 'result', requestId: request.requestId, result } });
      }
    });
  };
  FakeWorker.prototype.terminate = function terminate() {
    this.terminated = true;
  };
  return { ctor: FakeWorker };
}

function manualWorker() {
  function ManualWorker() {
    this.terminated = false;
    ManualWorker.instances.push(this);
  }
  ManualWorker.instances = [];
  ManualWorker.prototype.postMessage = function postMessage(request) {
    this.request = request;
  };
  ManualWorker.prototype.terminate = function terminate() {
    this.terminated = true;
  };
  ManualWorker.prototype.respond = function respond(result) {
    this.onmessage({ data: { type: 'result', requestId: this.request.requestId, result } });
  };
  ManualWorker.prototype.fail = function fail() {
    this.onerror(new Error('worker failed'));
  };
  return { ctor: ManualWorker };
}

function replayingEngine() {
  return {
    dealSpiderFromSeed: spider.dealSpiderFromSeed,
    replaySpiderActions: () => ({ won: true }),
  };
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('1초 안에 solved면 같은 시드의 실시간 검증 판을 반환한다 (CLAW-279)', async () => {
  const worker = fakeWorkerReturning({ status: 'solved', elapsedMs: 37, actions: [{ type: 'proof' }] });
  const engine = {
    dealSpiderFromSeed: spider.dealSpiderFromSeed,
    replaySpiderActions: () => ({ won: true }),
  };
  const provider = createSpiderDealProvider({ engine, WorkerCtor: worker.ctor, seeds: fixedSeedSource([41]) });

  const deal = await provider.next(1);

  assert.deepStrictEqual({ seed: deal.seed, verification: deal.verification, solverMs: deal.solverMs }, {
    seed: 41,
    verification: 'live',
    solverMs: 37,
  });
});

test('새 next는 이전 Worker를 종료하고 이전 요청을 대체한다 (CLAW-279)', async () => {
  const worker = manualWorker();
  const provider = createSpiderDealProvider({
    engine: replayingEngine(),
    WorkerCtor: worker.ctor,
    seeds: fixedSeedSource([11, 12]),
  });
  const first = provider.next(1);
  const firstFailure = assert.rejects(first, { code: 'REQUEST_SUPERSEDED' });
  const second = provider.next(1);

  assert.strictEqual(worker.ctor.instances[0].terminated, true);
  worker.ctor.instances[1].respond({ status: 'solved', elapsedMs: 4, actions: [{ type: 'proof' }] });
  assert.strictEqual((await second).seed, 12);
  await firstFailure;
});

test('destroy는 현재 Worker를 종료하고 요청을 끝낸다 (CLAW-279)', async () => {
  const worker = manualWorker();
  const provider = createSpiderDealProvider({ engine: replayingEngine(), WorkerCtor: worker.ctor });
  const pending = provider.next(1);
  const failure = assert.rejects(pending, { code: 'REQUEST_DESTROYED' });

  provider.destroy();

  assert.strictEqual(worker.ctor.instances[0].terminated, true);
  await failure;
});

test('1000ms 요청의 1100ms 감시 범위 안에 과도 실행 Worker를 종료한다 (CLAW-279)', async () => {
  const worker = manualWorker();
  const provider = createSpiderDealProvider({
    engine: spider,
    WorkerCtor: worker.ctor,
    timeoutMs: 1000,
    verifiedDeals: { 1: [] },
  });
  const pending = provider.next(1);
  const failure = assert.rejects(pending, { code: 'VERIFIED_DEALS_UNAVAILABLE' });

  await pause(1100);

  assert.strictEqual(worker.ctor.instances[0].terminated, true);
  await failure;
});

test('종료된 이전 Worker의 지연 응답은 현재 딜을 바꾸지 못한다 (CLAW-279)', async () => {
  const worker = manualWorker();
  const provider = createSpiderDealProvider({
    engine: replayingEngine(),
    WorkerCtor: worker.ctor,
    seeds: fixedSeedSource([21, 22]),
  });
  const first = provider.next(1);
  const firstFailure = assert.rejects(first, { code: 'REQUEST_SUPERSEDED' });
  const second = provider.next(1);

  worker.ctor.instances[0].respond({ status: 'solved', elapsedMs: 1, actions: [{ type: 'proof' }] });
  worker.ctor.instances[1].respond({ status: 'solved', elapsedMs: 2, actions: [{ type: 'proof' }] });

  assert.strictEqual((await second).seed, 22);
  await firstFailure;
});

test('손상된 검증 풀 뒤에는 임의 딜 대신 명시적으로 실패한다 (CLAW-279)', async () => {
  let plainDealCalls = 0;
  const engine = {
    dealSpiderFromSeed: spider.dealSpiderFromSeed,
    dealSpider() {
      plainDealCalls += 1;
    },
  };
  const provider = createSpiderDealProvider({
    engine,
    WorkerCtor: fakeWorkerReturning({ status: 'timeout', elapsedMs: 1, actions: [] }).ctor,
    verifiedDeals: { 1: [{ seed: 7, solutionLength: 0, checksum: 'invalid' }] },
  });

  await assert.rejects(provider.next(1), { code: 'VERIFIED_DEALS_UNAVAILABLE' });
  assert.strictEqual(plainDealCalls, 0);
});

test('timeout은 solved 검증 풀로만 후퇴한다 (CLAW-279)', async () => {
  const provider = createSpiderDealProvider({
    engine: spider,
    WorkerCtor: fakeWorkerReturning({ status: 'timeout', elapsedMs: 1000, actions: [] }).ctor,
    verifiedDeals: {
      4: [{
        seed: 99,
        solutionLength: 1,
        checksum: checksumFor(spider.dealSpiderFromSeed(4, 99)),
      }],
    },
    seeds: fixedSeedSource([3]),
  });

  const deal = await provider.next(4);

  assert.deepStrictEqual({ seed: deal.seed, verification: deal.verification }, {
    seed: 99,
    verification: 'verified-pool',
  });
});

test('Worker 오류도 checksum이 맞는 검증 풀로만 후퇴한다 (CLAW-279)', async () => {
  const worker = manualWorker();
  const provider = createSpiderDealProvider({
    engine: spider,
    WorkerCtor: worker.ctor,
    verifiedDeals: {
      2: [{
        seed: 77,
        solutionLength: 3,
        checksum: checksumFor(spider.dealSpiderFromSeed(2, 77)),
      }],
    },
  });
  const pending = provider.next(2);

  worker.ctor.instances[0].fail();

  assert.deepStrictEqual({ seed: (await pending).seed, verification: 'verified-pool' }, {
    seed: 77,
    verification: 'verified-pool',
  });
});

test('재생 불가능한 solved 응답은 실시간 성공으로 인정하지 않는다 (CLAW-279)', async () => {
  const provider = createSpiderDealProvider({
    engine: spider,
    WorkerCtor: fakeWorkerReturning({ status: 'solved', elapsedMs: 1, actions: [] }).ctor,
    verifiedDeals: {
      1: [{
        seed: 88,
        solutionLength: 2,
        checksum: checksumFor(spider.dealSpiderFromSeed(1, 88)),
      }],
    },
  });

  const deal = await provider.next(1);

  assert.deepStrictEqual({ seed: deal.seed, verification: deal.verification }, {
    seed: 88,
    verification: 'verified-pool',
  });
});

test('검증 풀은 최근 선택 시드를 피할 수 있을 때 다음 시드를 고른다 (CLAW-279)', async () => {
  const entries = [101, 102].map((seed) => ({
    seed,
    solutionLength: 1,
    checksum: checksumFor(spider.dealSpiderFromSeed(1, seed)),
  }));
  const provider = createSpiderDealProvider({
    engine: spider,
    WorkerCtor: fakeWorkerReturning({ status: 'timeout', elapsedMs: 1, actions: [] }).ctor,
    verifiedDeals: { 1: entries },
  });

  const first = await provider.next(1);
  const second = await provider.next(1);

  assert.deepStrictEqual([first.seed, second.seed], [101, 102]);
});
