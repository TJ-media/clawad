# Spider XP Animation and Verified Deals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the observable Windows XP Spider board layout and completion motion with existing CC0 cards, and start only deals whose solutions have been replay-verified.

**Architecture:** The existing `spider-solitaire.js` remains the authoritative mutable rules engine. A pure solver module searches copies of those positions and replays every candidate solution through the public engine; a Worker-backed deal provider chooses between one bounded live attempt and a checked-in verified seed pool. A separate presentation module computes completion origins and animation timing, while `games.js` owns DOM rendering and cancellation.

**Tech Stack:** JavaScript, Node.js 24+, CommonJS/UMD, Web Worker, browser DOM/CSS animations, `node:test`; Node/browser built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-25-spider-xp-animation-solver-design.md`

## Global Constraints

- Do not copy or add Microsoft executables, DLLs, images, sounds, icons, or source code.
- Reuse `apps/user-web/icons/english-pattern-playing-cards@2x.png` and its existing CC0 notice.
- Do not add runtime dependencies or server/API/persistence integration.
- `solved` requires a solution replayed to `won`; `timeout` is never treated as impossible or user-playable.
- Keep Spider work off the browser main thread and preserve responsive window drag/resize.
- Keep CommonJS and browser-global loading compatible and retain `'use strict'`.
- Do not touch unrelated `graphify-out/cache/semantic/**` changes.
- Do not commit, stage, push, merge, or change Jira status without explicit authorization in this task.
- Because the Atlassian connection currently requires reauthentication, continue under the existing CLAW-279 scope and report that issue-read limitation rather than creating or changing Jira data.

---

## File Responsibility Map

- `apps/user-web/spider-solitaire.js`: authoritative rules, seeded deals, and public action replay.
- `apps/user-web/spider-solver.js`: pure search, state keys, action enumeration, replay verification, result statuses.
- `apps/user-web/spider-solver-worker.js`: solve/cancel message boundary only.
- `apps/user-web/spider-deal-provider.js`: one-second live attempt, timeout cancellation, and verified-pool fallback.
- `apps/user-web/spider-verified-deals.js`: generated UMD/CommonJS manifest of replay-verified seeds.
- `apps/user-web/spider-presentation.js`: pure completion-origin and animation-plan calculations.
- `apps/user-web/games.js`: XP board renderer, menu state, overlays, input locking, lifecycle cancellation.
- `apps/user-web/index.html`: XP menu shell and sequential static module loading.
- `scripts/generate-spider-verified-deals.js`: generate and replay-check at least 256 seeds per difficulty.
- `scripts/benchmark-spider-solver.js`: warm-up and measure 100 seeds per difficulty.
- `docs/benchmarks/2026-08-25-spider-solver.md`: immutable benchmark command, environment, results, and selected runtime mode.
- `test/spider-solitaire.test.js`: rules/seed/replay contracts.
- `test/spider-solver.test.js`: search correctness, exhaustion, timeout, and false-positive prevention.
- `test/spider-deal-provider.test.js`: Worker/pool/failure orchestration.
- `test/spider-presentation.test.js`: layout-independent completion event/timing calculations.
- `test/user-web-games.test.js`: renderer, controller, accessibility, animation lock/cancel, and async new-game integration.
- `test/games.test.js`, `test/user-web.test.js`: lazy-loader and deploy asset contracts.

---

### Task 1: Deterministic deals and public solution replay

**Files:**
- Modify: `apps/user-web/spider-solitaire.js`
- Modify: `test/spider-solitaire.test.js`

**Interfaces:**
- Produces: `normalizeSpiderSeed(value): number` returning a non-zero unsigned 32-bit seed.
- Produces: `createSpiderSeededRandom(seed): () => number` using a documented xorshift32 sequence.
- Produces: `dealSpiderFromSeed(difficulty, seed): SpiderState`.
- Produces: `applySpiderAction(state, action): boolean`, where `action` is `{ type:'move', fromColumn, fromIndex, toColumn } | { type:'stock' }`.
- Produces: `replaySpiderActions(difficulty, seed, actions): { won:boolean, state:SpiderState, failedAt:number }`.

- [ ] **Step 1: Write failing deterministic-deal tests**

```js
test('같은 시드는 카드 ID까지 같은 스파이더 판을 만든다 (CLAW-279)', () => {
  const first = dealSpiderFromSeed(4, 0x12345678);
  const second = dealSpiderFromSeed(4, 0x12345678);
  assert.deepStrictEqual(first, second);
  assert.notDeepStrictEqual(first.tableau, dealSpiderFromSeed(4, 0x12345679).tableau);
});

test('0과 잘못된 시드는 재현 가능한 0이 아닌 uint32로 정규화한다 (CLAW-279)', () => {
  assert.strictEqual(normalizeSpiderSeed(0), 0x6d2b79f5);
  assert.strictEqual(normalizeSpiderSeed('bad'), 0x6d2b79f5);
});
```

- [ ] **Step 2: Run the engine test and verify RED**

Run: `node --test test/spider-solitaire.test.js`

Expected: failures name `dealSpiderFromSeed` and `normalizeSpiderSeed`; all earlier Spider tests stay green.

- [ ] **Step 3: Implement seeded shuffle through the existing deal path**

```js
function normalizeSpiderSeed(value) {
  const seed = Number(value) >>> 0;
  return seed || 0x6d2b79f5;
}

function createSpiderSeededRandom(value) {
  let state = normalizeSpiderSeed(value);
  return function seededRandom() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function dealSpiderFromSeed(difficulty, seed) {
  return dealSpider(difficulty, createSpiderSeededRandom(seed));
}
```

Export all three functions from the existing UMD factory. Do not replace the injected-random `dealSpider` API used by current tests.

- [ ] **Step 4: Write failing action/replay tests**

```js
test('공개 action API는 실제 이동과 재고만 적용하고 불법 수에서 멈춘다 (CLAW-279)', () => {
  const state = spiderFixture({ tableau: [[up('spades', 8)], [up('hearts', 9)]], stock: [] });
  assert.ok(applySpiderAction(state, { type: 'move', fromColumn: 0, fromIndex: 0, toColumn: 1 }));
  assert.ok(!applySpiderAction(state, { type: 'stock' }));
});

test('해답 재생은 첫 불법 action 인덱스를 보고하고 거짓 승리를 만들지 않는다 (CLAW-279)', () => {
  const result = replaySpiderActions(1, 123, [{ type: 'move', fromColumn: 99, fromIndex: 0, toColumn: 0 }]);
  assert.deepStrictEqual({ won: result.won, failedAt: result.failedAt }, { won: false, failedAt: 0 });
});
```

- [ ] **Step 5: Implement action dispatch and replay**

`applySpiderAction` must delegate to `moveSpiderRun` or `dealSpiderStock`; it must not duplicate rule logic. `replaySpiderActions` creates a fresh seeded deal, applies actions in order, returns immediately at the first failure, and uses `isSpiderWon` for the final verdict.

- [ ] **Step 6: Verify Task 1 GREEN**

Run: `node --test test/spider-solitaire.test.js`

Expected: all engine tests pass and two identical seeds serialize identically.

---

### Task 2: Complete, bounded solver with replay-verified output

**Files:**
- Create: `apps/user-web/spider-solver.js`
- Create: `test/spider-solver.test.js`

**Interfaces:**
- Consumes: `ClawadSpider` / CommonJS engine from Task 1.
- Produces: `spiderPositionKey(state): string` excluding score, moves, history, and duplicate-card IDs.
- Produces: `listSpiderSolverActions(state): SpiderAction[]` with one representative empty target.
- Produces: `solveSpiderState(initialState, options): SolverResult`.
- Produces: `solveSpiderSeed(difficulty, seed, options): SolverResult`.
- `options`: `{ timeoutMs, maxNodes, now, shouldCancel }`.
- `SolverResult`: `{ status:'solved'|'exhausted'|'timeout', actions, elapsedMs, visitedNodes, solutionLength }`.

- [ ] **Step 1: Write failing key and legal-action tests**

```js
test('상태 키는 열 순서와 카드 복사 ID 대칭을 정규화한다 (CLAW-279)', () => {
  const left = solverFixture({ tableau: [[card('copy-a', 'spades', 8)], [card('copy-b', 'hearts', 9)]] });
  const right = solverFixture({ tableau: [[card('other-b', 'hearts', 9)], [card('other-a', 'spades', 8)]] });
  assert.strictEqual(spiderPositionKey(left), spiderPositionKey(right));
});

test('빈 목적지는 첫 번째 한 곳만 열거해 대칭 분기를 만들지 않는다 (CLAW-279)', () => {
  const state = solverFixture({ tableau: [[up('spades', 8)], [], [], [up('hearts', 9)]], stock: [] });
  const emptyMoves = listSpiderSolverActions(state).filter((action) => action.type === 'move' && action.toColumn !== 3);
  assert.deepStrictEqual(new Set(emptyMoves.map((action) => action.toColumn)), new Set([1]));
});
```

- [ ] **Step 2: Run solver tests and verify RED**

Run: `node --test test/spider-solver.test.js`

Expected: module-not-found or missing-export failures only.

- [ ] **Step 3: Implement UMD shell, canonical key, and action enumeration**

The UMD factory must accept the engine by CommonJS `require('./spider-solitaire')` or browser `root.ClawadSpider`. Encode a card as `${faceUp ? 1 : 0}${suitCode}${rank.toString(36)}`, join cards within a column, sort complete column encodings, and append stock order plus completed suit counts. Enumerate each valid same-suit descending suffix and legal non-identical target; include `{type:'stock'}` only when the public stock rule can succeed.

- [ ] **Step 4: Write failing solved/exhausted/timeout tests**

```js
test('한 번의 이동으로 여덟 번째 묶음을 만드는 상태를 풀고 해답을 재생한다 (CLAW-279)', () => {
  const state = oneMoveWinFixture();
  const result = solveSpiderState(state, { timeoutMs: 1000, maxNodes: 1000 });
  assert.strictEqual(result.status, 'solved');
  assert.strictEqual(result.actions.length, 1);
  assert.ok(replayFixtureActions(state, result.actions).won);
});

test('유한한 무승리 상태를 모두 방문하면 exhausted를 반환한다 (CLAW-279)', () => {
  const result = solveSpiderState(noWinFiniteFixture(), { timeoutMs: 1000, maxNodes: 10000 });
  assert.strictEqual(result.status, 'exhausted');
});

test('시간이나 노드 상한은 불가능이 아니라 timeout이다 (CLAW-279)', () => {
  assert.strictEqual(solveSpiderState(oneMoveWinFixture(), { maxNodes: 0 }).status, 'timeout');
  assert.strictEqual(solveSpiderState(oneMoveWinFixture(), { timeoutMs: 0 }).status, 'timeout');
});
```

- [ ] **Step 5: Implement iterative deepening with sound deduplication**

Use depth-first iterations. Each frame stores `{ state, actions, depth }`; clone state values but reset `history` after every public-engine action. Maintain a per-iteration best-depth transposition map. Remove a successor only when its canonical key was already reached at equal or lower depth. Order successors by completion count, hidden-card reduction, new empty column, same-suit extension, then mixed-suit move. Never drop a unique successor solely because its heuristic score is low.

Return `exhausted` only when an iteration produces no depth cutoff and the frontier empties. Check `shouldCancel()`, elapsed time, and `maxNodes` before expanding each state; any limit yields `timeout`.

- [ ] **Step 6: Replay-check every candidate solution before returning solved**

Before returning `solved`, clone the original state, apply every action with the authoritative engine, and require `isSpiderWon`. If replay fails, continue searching and expose a test-only `replayFailures` counter; never return the invalid path.

- [ ] **Step 7: Verify Task 2 GREEN**

Run: `node --test test/spider-solver.test.js test/spider-solitaire.test.js`

Expected: all tests pass; no `solved` result lacks a winning replay.

---

### Task 3: Worker boundary and verified-deal provider

**Files:**
- Create: `apps/user-web/spider-solver-worker.js`
- Create: `apps/user-web/spider-deal-provider.js`
- Create: `test/spider-deal-provider.test.js`

**Interfaces:**
- Consumes: engine and solver from Tasks 1–2.
- Produces Worker messages:
  - request `{ type:'solve', requestId, difficulty, seed, timeoutMs, maxNodes }`
  - response `{ type:'result', requestId, result }`
- Produces: `createSpiderDealProvider(options)` returning `{ next(difficulty), cancel(), destroy() }`.
- `next` resolves `{ state, seed, verification:'live'|'verified-pool', solverMs }` or rejects with code `VERIFIED_DEALS_UNAVAILABLE`.

- [ ] **Step 1: Write failing provider tests for live success and timeout fallback**

```js
test('1초 안에 solved면 같은 시드의 실시간 검증 판을 반환한다 (CLAW-279)', async () => {
  const worker = fakeWorkerReturning({ status: 'solved', elapsedMs: 37, actions: [] });
  const provider = createSpiderDealProvider({ engine, WorkerCtor: worker.ctor, seeds: fixedSeedSource([41]) });
  const deal = await provider.next(1);
  assert.deepStrictEqual({ seed: deal.seed, verification: deal.verification }, { seed: 41, verification: 'live' });
});

test('timeout·Worker 오류는 solved 검증 풀로만 후퇴한다 (CLAW-279)', async () => {
  const provider = createSpiderDealProvider({
    engine,
    WorkerCtor: fakeWorkerReturning({ status: 'timeout' }).ctor,
    verifiedDeals: { 4: [{ seed: 99, checksum: checksumFor(engine.dealSpiderFromSeed(4, 99)) }] },
  });
  assert.strictEqual((await provider.next(4)).verification, 'verified-pool');
});
```

- [ ] **Step 2: Run provider tests and verify RED**

Run: `node --test test/spider-deal-provider.test.js`

Expected: missing-module failure.

- [ ] **Step 3: Implement one-request Worker isolation**

The Worker imports `spider-solitaire.js` then `spider-solver.js` and executes exactly one solve request. The provider creates a fresh Worker for every live attempt and calls `terminate()` on timeout, superseding new-game request, or destroy; a synchronous Worker cannot process a cancel message while searching. Ignore late results whose request ID is no longer current. Do not use `eval`, blob workers, network calls, or timers longer than the request deadline plus a 100ms watchdog margin.

- [ ] **Step 4: Implement provider fallback and pool validation**

Only accept manifest entries with an unsigned seed, positive solution length, and checksum matching the freshly dealt initial state. Keep `recentSeeds[difficulty]` in memory; exclude the last 32 selections when alternatives exist. A missing/corrupt/empty pool after live failure rejects with `VERIFIED_DEALS_UNAVAILABLE`; it must never call plain `dealSpider(difficulty, Math.random)`.

- [ ] **Step 5: Add cancellation and late-response tests**

Assert that a second `next` terminates the first Worker, `destroy` terminates the current Worker, the 1100ms watchdog terminates an overrun 1000ms request, and a late response cannot replace the current deal.

- [ ] **Step 6: Verify Task 3 GREEN**

Run: `node --test test/spider-deal-provider.test.js test/spider-solver.test.js test/spider-solitaire.test.js`

Expected: all provider/solver/engine tests pass.

---

### Task 4: Benchmark tooling and at least 256 verified seeds per difficulty

**Files:**
- Create: `scripts/benchmark-spider-solver.js`
- Create: `scripts/generate-spider-verified-deals.js`
- Create: `apps/user-web/spider-verified-deals.js`
- Create: `docs/benchmarks/2026-08-25-spider-solver.md`
- Modify: `test/spider-solver.test.js`
- Modify: `test/games.test.js`

**Interfaces:**
- Consumes: `solveSpiderSeed`, `replaySpiderActions`, `dealSpiderFromSeed`.
- Produces manifest: `{ version:1, generatedAt, difficulties: { 1: Deal[], 2: Deal[], 4: Deal[] } }`.
- `Deal`: `{ seed:number, solutionLength:number, checksum:string }`.
- Produces benchmark JSON/Markdown rows for mean, median, p95, max, statuses, node counts, solution lengths, and replay failures.

- [ ] **Step 1: Write failing manifest and statistics tests**

```js
test('검증 딜 manifest는 난이도별 고유 solved 시드를 256개 이상 가진다 (CLAW-279)', () => {
  const manifest = require('../apps/user-web/spider-verified-deals.js');
  for (const difficulty of [1, 2, 4]) {
    const deals = manifest.difficulties[difficulty];
    assert.ok(deals.length >= 256);
    assert.strictEqual(new Set(deals.map((deal) => deal.seed)).size, deals.length);
  }
});

test('벤치마크 요약은 timeout을 제한 시간 경과값으로 평균에 포함한다 (CLAW-279)', () => {
  assert.deepStrictEqual(summarizeTimes([10, 20, 1000]), { mean: 343.333, median: 20, p95: 1000, max: 1000 });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/spider-solver.test.js test/games.test.js`

Expected: missing manifest/statistics failures.

- [ ] **Step 3: Implement generator with replay gate**

CLI: `node scripts/generate-spider-verified-deals.js --count=256 --timeout-ms=30000 --start-seed=1`.

For each difficulty, increment unsigned seeds, run the solver, and write an entry only when status is `solved`, action replay wins, and the initial checksum is stable. Write to a temporary sibling file and rename only after all three difficulties reach 256; interruption must leave the previous manifest intact.

- [ ] **Step 4: Generate the manifest and independently sample-replay it**

Run: `node scripts/generate-spider-verified-deals.js --count=256 --timeout-ms=30000 --start-seed=1`

Then run a verification command that selects the first, middle, and last manifest entry for each difficulty, solves/replays them, and exits non-zero on any mismatch. Record generator elapsed time and any solver improvements required to finish; do not lower the 256-deal requirement or label timeouts solved.

- [ ] **Step 5: Implement and run the 100-deal benchmark**

CLI: `node scripts/benchmark-spider-solver.js --samples=100 --warmup=10 --timeout-ms=30000 --start-seed=1000001`

Use `os.cpus()[0].model`, `process.version`, `process.platform`, and `performance.now()`. Run one search at a time. Count all timeout elapsed values in the overall mean and also report solved-only mean separately.

- [ ] **Step 6: Write the actual benchmark report**

Populate `docs/benchmarks/2026-08-25-spider-solver.md` with the exact command, machine details, raw aggregate table, replay-failure count, and selected mode per difficulty. Select `live` only if mean is at most 1000ms, at least 95/100 are conclusive within 1000ms, and replay failures are zero; otherwise select `verified-pool`.

- [ ] **Step 7: Verify Task 4 GREEN**

Run: `node --test test/spider-solver.test.js test/games.test.js`

Expected: manifest shape, uniqueness, checksum samples, and statistics tests pass.

---

### Task 5: Pure XP completion-event and motion plan

**Files:**
- Create: `apps/user-web/spider-presentation.js`
- Create: `test/spider-presentation.test.js`

**Interfaces:**
- Produces: `detectSpiderCompletionEvents(before, after, operation): CompletionEvent[]`.
- `operation`: `{ type:'move', fromColumn, toColumn, movedCount } | { type:'stock' }`.
- `CompletionEvent`: `{ column, slotIndex, suit }` ordered by engine removal order.
- Produces: `createSpiderCompletionMotion(event, originRect, targetRect): MotionCard[]`.
- `MotionCard`: `{ suit, rank, delayMs, durationMs, fromX, fromY, toX, toY }`.

- [ ] **Step 1: Write failing origin tests for move, stock, and multiple completions**

```js
test('이동의 기대 열 길이에서 13장씩 줄어든 열을 완료 원점으로 찾는다 (CLAW-279)', () => {
  const before = { tableauLengths: [5, 12], completed: [] };
  const after = { tableauLengths: [4, 0], completed: ['spades'] };
  assert.deepStrictEqual(detectSpiderCompletionEvents(before, after,
    { type: 'move', fromColumn: 0, toColumn: 1, movedCount: 1 }),
    [{ column: 1, slotIndex: 0, suit: 'spades' }]);
});

test('재고 한 번에 여러 열이 완성되면 열 순서로 이벤트를 만든다 (CLAW-279)', () => {
  const before = { tableauLengths: [12, 12, 4], completed: [] };
  const after = { tableauLengths: [0, 0, 5], completed: ['hearts', 'spades'] };
  assert.deepStrictEqual(detectSpiderCompletionEvents(before, after, { type: 'stock' }).map((e) => e.column), [0, 1]);
});
```

- [ ] **Step 2: Run presentation tests and verify RED**

Run: `node --test test/spider-presentation.test.js`

Expected: missing-module failure.

- [ ] **Step 3: Implement exact integer origin accounting**

For moves, expected lengths subtract `movedCount` from source and add it to target. For stock, add one to every column. For each column require `(expected - actual) / 13` to be a non-negative integer; otherwise return no event for that column and expose `valid:false` from an internal calculation rather than inventing animation. Map newly appended `after.completed` suits to events in ascending column/removal order.

- [ ] **Step 4: Write failing K-to-A stagger tests**

```js
test('완성 모션은 K부터 A까지 13장을 28ms 간격으로 같은 슬롯에 보낸다 (CLAW-279)', () => {
  const cards = createSpiderCompletionMotion(
    { suit: 'hearts' }, { left: 400, top: 220 }, { left: 24, top: 610 });
  assert.deepStrictEqual(cards.map((card) => card.rank), [13,12,11,10,9,8,7,6,5,4,3,2,1]);
  assert.deepStrictEqual(cards.map((card) => card.delayMs), Array.from({ length: 13 }, (_, i) => i * 28));
  assert.ok(cards.every((card) => card.durationMs === 360 && card.toX === 24 && card.toY === 610));
});
```

- [ ] **Step 5: Implement motion plan constants from the reference frame log**

Use `CARD_STAGGER_MS = 28` and `CARD_TRAVEL_MS = 360` as the first measured target. If reference frame measurement differs by more than 50ms, update constants and this exact test together with the measured frame table in the benchmark/report notes; do not tune by unrecorded guesswork.

- [ ] **Step 6: Verify Task 5 GREEN**

Run: `node --test test/spider-presentation.test.js`

Expected: all event and motion tests pass.

---

### Task 6: XP board layout and menu shell

**Files:**
- Modify: `apps/user-web/games.js`
- Modify: `apps/user-web/index.html`
- Modify: `test/user-web-games.test.js`

**Interfaces:**
- Consumes: engine state and the existing CC0 `cardMarkup`.
- Produces DOM regions: `.spider-tableau`, `.spider-foundations`, `.spider-score-panel`, `.spider-stock-packets`.
- Produces commands: existing `new-spider-1/2/4`, `undo-spider`, `hint-spider`, plus `deal-spider` from the XP menu.

- [ ] **Step 1: Write failing XP layout contract tests**

```js
test('XP 스파이더 하단은 완료 묶음·점수판·5개 재고를 좌중우로 배치한다 (CLAW-279)', () => {
  const state = spiderState({ completed: ['spades'], stock: Array(50).fill(backCard()) });
  const markup = spiderMarkup(state, null, null, '');
  assert.match(markup, /class="spider-foundations"/);
  assert.match(markup, /class="spider-score-panel"[^>]*>[^<]*점수:/);
  assert.strictEqual((markup.match(/class="spider-stock-packet/g) || []).length, 5);
  assert.match(markup, /완료 묶음 1: 스페이드[^]*english-pattern-playing-cards@2x\.png/);
});
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `node --test test/user-web-games.test.js`

Expected: only new XP-layout assertions fail.

- [ ] **Step 3: Replace top completion/stock strip with XP anchors**

Keep the ten-column renderer but move foundations to absolute lower-left, score/moves to an inset lower-center panel, and five overlapping stock packet buttons to lower-right. Render each completed suit as the existing King sprite; empty completion slots are not shown in the normal XP board. Preserve accessible list semantics with an offscreen summary `완성: n/8`.

- [ ] **Step 4: Add responsive scale variables**

Calculate a CSS custom property `--spider-board-scale` from available width with a floor that fits ten cards. Apply it to horizontal gaps and the lower rail, not to the window chrome. Add tests for the pure `spiderCardOffsets` height behavior and source checks for left/center/right anchoring.

- [ ] **Step 5: Rebuild the menu as XP Game / Deal / Help**

`index.html` exposes three top-level menu buttons. `게임(G)` toggles a contained menu with radio items for 1/2/4 suits plus Undo and Hint; `카드 나누기(D)` emits `deal-spider`; `도움말(H)` retains the existing help behavior. The controller updates `aria-checked` and visible checkmarks after every new deal.

- [ ] **Step 6: Verify Task 6 GREEN**

Run: `node --test test/user-web-games.test.js test/games.test.js test/user-web.test.js`

Expected: all shell/UI contracts pass, including existing start-menu and lifecycle tests.

---

### Task 7: Completion animation, victory celebration, and lifecycle safety

**Files:**
- Modify: `apps/user-web/games.js`
- Modify: `apps/user-web/index.html`
- Modify: `apps/user-web/Dockerfile`
- Modify: `apps/user-web/Caddyfile`
- Modify: `test/user-web-games.test.js`
- Modify: `test/games.test.js`
- Modify: `test/user-web.test.js`

**Interfaces:**
- Consumes: `ClawadSpiderPresentation.detectSpiderCompletionEvents` and `createSpiderCompletionMotion`.
- Extends Spider instance with `{ animating, animationToken, animationNodes, animationTimers }`.
- Produces: `playSpiderCompletionEvents(instance, events): Promise<void>` and `cancelSpiderAnimation(instance): void`.
- The current presentation event's `slotIndex` denotes the source run's first card index. Derive the destination foundation index from the completed count before the operation plus the event's order.
- Advance the presentation-only part of Task 8: load `spider-presentation.js` after the engine and before `games.js`, and register that asset in Docker/Caddy now. Verified provider/pool loading remains Task 8. The animation must work in the browser even while verified-pool generation is blocked.

- [ ] **Step 1: Write failing controller tests for lock and ordered completion**

```js
test('완성 연출 중 입력을 잠그고 13장 뒤 완료 슬롯을 확정한다 (CLAW-279)', async () => {
  const dom = spiderDomFixture(spiderEngine, { reducedMotion: false, manualAnimations: true });
  const instance = mountSpider(dom.root, dom.options);
  dom.completeOneRun();
  assert.strictEqual(instance.animating, true);
  assert.strictEqual(dom.animationCards().length, 13);
  assert.ok(!spiderInputEnabled(instance));
  await dom.finishAnimations();
  assert.strictEqual(instance.animating, false);
  assert.match(dom.root.innerHTML, /완료 묶음 1: 스페이드/);
});
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `node --test test/user-web-games.test.js test/spider-presentation.test.js`

Expected: missing animation API/state assertions fail.

- [ ] **Step 3: Capture completion events around successful mutations**

Before move or stock, capture tableau lengths and completed suits. After the engine mutation, calculate events using the exact operation metadata. Render the final state, set `animating=true`, then overlay synthetic CC0 K-to-A cards at the source-column anchor and animate them to the new lower-left foundation position.

- [ ] **Step 4: Implement queue, timeout fallback, and reduced motion**

Play multiple events serially. Resolve each card on `animationend`; also arm one fallback timer for `lastDelay + duration + 100ms`. If `matchMedia('(prefers-reduced-motion: reduce)').matches`, skip nodes/timers and immediately reveal the final foundation.

- [ ] **Step 5: Write and pass cancellation tests**

Cover new game, minimize/pause, destroy/close, and remount. Each must increment `animationToken`, remove every `.spider-completion-fly-card` and victory particle, clear timers, set `animating=false`, and prevent stale callbacks from changing the new board.

- [ ] **Step 6: Add eighth-stack XP-style victory celebration**

After the final completion event settles and `state.won` is true, create a bounded set of `aria-hidden` CSS particles and short card-bounce clones over the green board. Remove all celebration nodes after the measured duration or any lifecycle cancellation. Keep the existing textual win message visible without motion.

- [ ] **Step 7: Verify Task 7 GREEN**

Run: `node --test test/user-web-games.test.js test/spider-presentation.test.js test/spider-solitaire.test.js`

Expected: animation, reduced-motion, cancellation, controller, and engine tests all pass.

---

### Task 8: Async verified new games, lazy loading, and deploy assets

**Files:**
- Modify: `apps/user-web/games.js`
- Modify: `apps/user-web/index.html`
- Modify: `apps/user-web/Dockerfile`
- Modify: `apps/user-web/Caddyfile`
- Modify: `test/user-web-games.test.js`
- Modify: `test/games.test.js`
- Modify: `test/user-web.test.js`

**Interfaces:**
- Consumes browser globals: `ClawadSpider`, `ClawadSpiderPresentation`, `ClawadSpiderVerifiedDeals`, `ClawadSpiderDealProvider`.
- Spider instance gains `{ dealProvider, dealRequestToken, verifying }`.
- New-game status: `완료 가능한 판 확인 중…`, then `검증 완료 · {solverMs}ms` or pool label.

- [ ] **Step 1: Write failing sequential-loader and asset tests**

Assert exact load order:

```text
spider-solitaire.js
spider-presentation.js
spider-verified-deals.js
spider-deal-provider.js
games.js
```

Assert Worker scripts and all four new static assets are copied by Docker and included in Caddy's `no-store` matcher.

- [ ] **Step 2: Run shell tests and verify RED**

Run: `node --test test/games.test.js test/user-web-games.test.js test/user-web.test.js`

Expected: only new order/assets/async-new-game assertions fail.

- [ ] **Step 3: Extend the shared loader with retry cleanup**

Load the four main-thread Spider dependencies sequentially before `games.js`. Reset the shared promise after any failure, preserving the existing retry behavior. `spider-solver.js` is not loaded on the main thread; `spider-solver-worker.js` imports it inside the Worker.

- [ ] **Step 4: Make Spider new-game creation asynchronous and race-safe**

On mount or a difficulty command, increment `dealRequestToken`, leave the previous playable board visible, set `verifying=true`, and call `dealProvider.next(difficulty)`. Apply a resolved deal only when the token still matches and the instance is mounted. During the request, input is disabled. On provider failure, preserve the old board and render a retryable Korean error; never create a random fallback.

- [ ] **Step 5: Add async race and failure tests**

Resolve two difficulty requests out of order and assert only the latest appears. Close before resolution and assert no DOM/state mutation. Reject both live and pool paths and assert `VERIFIED_DEALS_UNAVAILABLE` produces no new board.

- [ ] **Step 6: Register production assets**

Add `spider-presentation.js`, `spider-verified-deals.js`, `spider-deal-provider.js`, `spider-solver.js`, and `spider-solver-worker.js` to the explicit Docker copy. Add each URL beside existing game scripts in the Caddy no-store matcher.

- [ ] **Step 7: Verify Task 8 GREEN**

Run: `node --test test/games.test.js test/user-web-games.test.js test/user-web.test.js test/spider-deal-provider.test.js`

Expected: loader retry, async races, and deploy asset tests pass.

---

### Task 9: Full verification, measured fidelity, and local browser QA

**Files:**
- Modify only the smallest owning file if verification exposes a defect.
- Finalize: `docs/benchmarks/2026-08-25-spider-solver.md`

**Interfaces:**
- Consumes the complete feature and produces final evidence.

- [ ] **Step 1: Run fresh syntax and full tests**

Run: `npm.cmd run lint`

Run: `npm.cmd test`

Expected: both exit 0, with the exact test count recorded.

- [ ] **Step 2: Re-run the final benchmark on the completed tree**

Run: `node scripts/benchmark-spider-solver.js --samples=100 --warmup=10 --timeout-ms=30000 --start-seed=1000001`

Replace preliminary measurements in the benchmark document with this final run and verify that runtime mode flags match the documented thresholds.

- [ ] **Step 3: Validate every distributed deal entry structurally and sample replay**

Run the manifest verifier for all checksums and uniqueness, then solve/replay the first, middle, and last entry of each difficulty. Expected: zero invalid entries and zero replay failures.

- [ ] **Step 4: Start the current isolated worktree at `127.0.0.1:4173`**

Stop only a listener proven to serve an older owned worktree; otherwise reuse the live server. Serve `apps/user-web` without adding a package and verify `/`, `/spider-solver-worker.js`, and `/spider-verified-deals.js` return 200.

- [ ] **Step 5: Browser-check XP layout at three sizes**

At 960×719, compare screenshot anchor coordinates with the public XP reference and record left foundations, center score panel, right stock, and ten-column positions. Repeat at the default window, maximized window, and minimum supported window. Expected: reference-size anchor differences are at most 8px and no horizontal game-board scrollbar appears.

- [ ] **Step 6: Browser-check completion and lifecycle animation**

Use a verified near-completion fixture exposed only by the test harness, not production UI. Complete one run, verify 13 K-to-A overlay cards stagger to the next lower-left foundation within the recorded ±50ms tolerance, and verify input is blocked. Repeat while minimizing and closing to confirm cleanup. Enable reduced motion and confirm instant completion with no overlay.

- [ ] **Step 7: Browser-check solver delivery paths**

Start 1-, 2-, and 4-suit games and verify the status reports `live` or `verified-pool` according to the benchmark. Force a Worker failure through the test harness and confirm pool fallback; force pool corruption and confirm no random board starts. Console warnings/errors must be zero.

- [ ] **Step 8: Inspect scoped changes**

Run:

```powershell
git diff --check -- apps/user-web scripts test docs/superpowers docs/benchmarks
git status --short --branch
```

Expected: only planned Spider application/test/docs/deploy files plus previously known unrelated user changes; no staged files or commits.
