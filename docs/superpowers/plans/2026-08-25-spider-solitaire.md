# Spider Solitaire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an XP-style Spider Solitaire game with 1/2/4-suit difficulty, undo, hint, scoring, and pointer drag while preserving the Klondike drag fix.

**Architecture:** A focused UMD/CommonJS rules engine in `spider-solitaire.js` owns deterministic state transitions and history. `games.js` owns DOM rendering and input, while `index.html` owns the desktop window and lazy script lifecycle. Existing CC0 card artwork and pointer-drag positioning are reused.

**Tech Stack:** JavaScript, Node.js 24+, CommonJS/UMD, browser DOM APIs, `node:test`; no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-spider-solitaire-design.md`

## Global Constraints

- Keep `CommonJS` compatibility and `'use strict'`; use only Node/browser built-ins.
- Do not add a runtime package.
- Keep game state in memory and disconnected from API, authentication, rewards, and persistent storage.
- Reuse `apps/user-web/icons/english-pattern-playing-cards@2x.png` and its recorded CC0 notice.
- Do not touch unrelated `graphify-out/cache/semantic/**` changes.
- Do not commit, push, or change Jira status unless the user explicitly requests it.

---

### Task 1: Preserve the card grab point

**Files:**
- Modify: `apps/user-web/games.js`
- Test: `test/user-web-games.test.js`

**Interfaces:**
- Produces: `createSolitairePointerDrag(source, event, bounds)` with `grabOffsetX` and `grabOffsetY`.
- Produces: `solitaireDragGhostTransform(drag): string`.

- [x] **Step 1: Write the failing regression test**

```js
test('드래그 카드는 처음 잡은 지점을 커서 아래에 유지한다 (CLAW-278)', () => {
  const drag = createSolitairePointerDrag(
    { zone: 'tableau', column: 3, index: 2 },
    { pointerId: 7, clientX: 132, clientY: 98 },
    { left: 100, top: 80 },
  );
  assert.strictEqual(solitaireDragGhostTransform(drag), 'translate3d(100px,80px,0)');
});
```

- [x] **Step 2: Verify the test fails because the transform helper is absent**

Run: `node --test test/user-web-games.test.js`
Expected: one failure, `solitaireDragGhostTransform is not a function`.

- [x] **Step 3: Store the pointer-to-card offset and use it for the ghost transform**

```js
function solitaireDragGhostTransform(drag) {
  return `translate3d(${drag.clientX - drag.grabOffsetX}px,${drag.clientY - drag.grabOffsetY}px,0)`;
}
```

- [x] **Step 4: Verify the focused test file passes**

Run: `node --test test/user-web-games.test.js`
Expected: 37 tests pass, 0 fail.

### Task 2: Create difficulty decks and the initial Spider deal

**Files:**
- Create: `apps/user-web/spider-solitaire.js`
- Create: `test/spider-solitaire.test.js`

**Interfaces:**
- Produces: `normalizeSpiderDifficulty(value): 1 | 2 | 4`.
- Produces: `createSpiderDeck(difficulty): SpiderCard[]`.
- Produces: `dealSpider(difficulty, random = Math.random): SpiderState`.
- `SpiderCard`: `{ id: string, suit: 'clubs'|'spades'|'hearts'|'diamonds', rank: number, faceUp: boolean }`.
- `SpiderState`: `{ difficulty, tableau, stock, completed, score, moves, history, won }`.

- [ ] **Step 1: Write failing tests for deck multiplicity and invalid difficulty**

```js
test('난이도별로 104장을 정해진 무늬 수로 만든다 (CLAW-279)', () => {
  assert.deepStrictEqual(new Set(createSpiderDeck(1).map((card) => card.suit)), new Set(['spades']));
  assert.deepStrictEqual(new Set(createSpiderDeck(2).map((card) => card.suit)), new Set(['spades', 'hearts']));
  assert.strictEqual(new Set(createSpiderDeck(4).map((card) => card.suit)).size, 4);
  assert.strictEqual(createSpiderDeck(4).length, 104);
  assert.strictEqual(normalizeSpiderDifficulty(3), 1);
});
```

- [ ] **Step 2: Run the new test and verify module/function absence**

Run: `node --test test/spider-solitaire.test.js`
Expected: failure loading `../apps/user-web/spider-solitaire.js`.

- [ ] **Step 3: Add the UMD module, difficulty normalization, and duplicated 104-card deck**

```js
(function spiderModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClawadSpider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function spiderFactory() {
  'use strict';
  const SUITS_BY_DIFFICULTY = {
    1: ['spades'],
    2: ['spades', 'hearts'],
    4: ['clubs', 'spades', 'hearts', 'diamonds'],
  };
  // Return the public pure-rule API defined by this plan.
});
```

- [ ] **Step 4: Write the failing initial-deal test**

```js
test('초기 판은 4개 열에 6장, 6개 열에 5장을 놓고 50장을 남긴다 (CLAW-279)', () => {
  const state = dealSpider(2, () => 0.25);
  assert.deepStrictEqual(state.tableau.map((pile) => pile.length), [6,6,6,6,5,5,5,5,5,5]);
  assert.strictEqual(state.stock.length, 50);
  assert.ok(state.tableau.every((pile) => pile.at(-1).faceUp));
  assert.ok(state.tableau.every((pile) => pile.slice(0, -1).every((card) => !card.faceUp)));
  assert.deepStrictEqual({ score: state.score, moves: state.moves }, { score: 500, moves: 0 });
});
```

- [ ] **Step 5: Implement Fisher-Yates shuffle and the exact 54-card initial deal**

Use the injected `random` for every shuffle choice. Assign unique ids containing copy index, suit, and rank so duplicated cards remain distinct.

- [ ] **Step 6: Run engine tests and inspect the local diff**

Run: `node --test test/spider-solitaire.test.js`
Expected: all Task 2 tests pass.

Run: `git diff --check -- apps/user-web/spider-solitaire.js test/spider-solitaire.test.js`
Expected: exit 0.

### Task 3: Implement moves, completion, stock deals, score, and history

**Files:**
- Modify: `apps/user-web/spider-solitaire.js`
- Test: `test/spider-solitaire.test.js`

**Interfaces:**
- Produces: `isSpiderRun(cards): boolean` for same-suit descending runs.
- Produces: `moveSpiderRun(state, fromColumn, fromIndex, toColumn): boolean`.
- Produces: `dealSpiderStock(state): { ok: boolean, reason?: 'EMPTY_COLUMN'|'STOCK_EMPTY' }`.
- Produces: `undoSpider(state): boolean`.
- Produces: `isSpiderWon(state): boolean`.

- [ ] **Step 1: Write failing move tests**

```js
test('다른 무늬 위에도 한 단계 낮게 놓지만 같은 무늬 연속 묶음만 옮긴다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [[up('spades', 8), up('spades', 7)], [up('hearts', 9)], [up('clubs', 9), up('diamonds', 8)]],
  });
  assert.ok(moveSpiderRun(state, 0, 0, 1));
  assert.ok(!moveSpiderRun(state, 2, 0, 1));
});
```

Include literal fixtures for empty-column moves, same-column rejection, invalid indices, and revealing the new source top.

- [ ] **Step 2: Run tests and verify missing move functions fail**

Run: `node --test test/spider-solitaire.test.js`
Expected: failures naming `moveSpiderRun` and `isSpiderRun`.

- [ ] **Step 3: Implement one validated move transaction**

Before mutation, push a deep snapshot excluding `history`. On success, splice the run, append to the target, reveal the source top, subtract one point down to zero, increment moves, then repeatedly remove completed K-A runs.

- [ ] **Step 4: Write failing completion and win tests**

```js
test('같은 무늬 K-A를 제거하고 100점을 더해 8묶음이면 승리한다 (CLAW-279)', () => {
  const state = spiderFixture({ tableau: [descendingSuit('spades')], completed: Array(7).fill('hearts') });
  assert.ok(moveSpiderRun(state, 1, 0, 0));
  assert.strictEqual(state.completed.length, 8);
  assert.strictEqual(state.won, true);
});
```

Use a source card that legally completes the destination run so the test exercises the public move boundary.

- [ ] **Step 5: Implement automatic completion removal and source reveal chaining**

Only the bottom 13 cards qualify; their ranks must be literal `[13,12,11,10,9,8,7,6,5,4,3,2,1]` and all suits equal.

- [ ] **Step 6: Write failing stock-deal tests**

Assert that a 10-card deal adds one face-up card to every column, costs one point/move, and records history. Assert that an empty column or fewer than 10 stock cards makes no state change and returns the exact reason.

- [ ] **Step 7: Implement atomic stock dealing**

Validate first; mutate only after validation. After dealing, run completion removal for all columns.

- [ ] **Step 8: Write failing repeated-undo tests**

Perform a move and a stock deal, undo twice, and compare literal tableau/stock/completed values to the earlier snapshots. Verify each undo costs one point and adds one move after restoration.

- [ ] **Step 9: Implement history snapshots and repeated undo**

Restore game values from `history.pop()` without replacing the existing history array. Then apply the undo cost to restored score/moves.

- [ ] **Step 10: Run all engine tests**

Run: `node --test test/spider-solitaire.test.js`
Expected: all Task 2–3 tests pass, 0 fail.

### Task 4: Implement deterministic hints

**Files:**
- Modify: `apps/user-web/spider-solitaire.js`
- Test: `test/spider-solitaire.test.js`

**Interfaces:**
- Produces: `findSpiderHint(state): { type: 'move', fromColumn, fromIndex, toColumn } | { type: 'stock' } | null`.

- [ ] **Step 1: Write failing hint-priority tests**

Create literal boards proving priority order: reveal a hidden card or empty a column, same-suit connection, mixed-suit legal connection, stock, then `null`. Assert the exact returned object.

- [ ] **Step 2: Run tests and verify `findSpiderHint` is absent**

Run: `node --test test/spider-solitaire.test.js`
Expected: failure naming `findSpiderHint`.

- [ ] **Step 3: Enumerate legal moves without mutating state and sort by a numeric priority**

Use source column, source index, and target column as stable tie breakers. Return `{ type: 'stock' }` only when all columns are non-empty and at least 10 stock cards remain.

- [ ] **Step 4: Run engine tests and mutation-check the hint ordering**

Run: `node --test test/spider-solitaire.test.js`
Expected: all tests pass.

Mentally swap the same-suit and mixed-suit priority values; the literal priority test must fail.

### Task 5: Render and operate the Spider window

**Files:**
- Modify: `apps/user-web/games.js`
- Test: `test/user-web-games.test.js`

**Interfaces:**
- Consumes: `globalThis.ClawadSpider` browser API from Tasks 2–4.
- Produces: `mountSpider(root)`, registered through `mount('spider', root, generation)`.
- Reuses: `cardMarkup`, `createSolitairePointerDrag`, `updateSolitairePointerDrag`, and `solitaireDragGhostTransform`.

- [ ] **Step 1: Write failing UI contract tests**

Assert that Spider CSS uses `english-pattern-playing-cards@2x.png`, renders 10 `.spider-column` targets, renders score/moves/completed/stock status, and contains commands `new-spider-1`, `new-spider-2`, `new-spider-4`, `undo-spider`, `hint-spider`.

- [ ] **Step 2: Run the focused UI tests and verify Spider markup is absent**

Run: `node --test test/user-web-games.test.js`
Expected: only new Spider assertions fail.

- [ ] **Step 3: Add Spider CSS and renderer**

Use the existing 72×96 sprite coordinate calculation. Keep hidden field cards disabled. Compute tighter overlap offsets to keep tall 10-column boards within the resizable window.

- [ ] **Step 4: Add click and custom pointer-drag movement**

Create a Spider-specific selection `{ column, index }`. On drag, clone the selected same-suit run, preserve `grabOffsetX/Y`, and resolve the destination from `elementFromPoint(event.clientX, event.clientY)`.

- [ ] **Step 5: Add stock, difficulty, undo, hint, and keyboard commands**

`Ctrl+Z` and `H` act only when the Spider instance is mounted, visible, not minimized, not paused, and its window is active. Hint applies `.hint-source` and `.hint-target` classes without changing engine state.

- [ ] **Step 6: Add pause/resume/destroy cleanup**

Remove pointer, click, command, and key listeners plus any drag ghost. Preserve the in-memory board across minimize/resume and discard it on close/remount.

- [ ] **Step 7: Run focused engine and UI tests**

Run: `node --test test/spider-solitaire.test.js test/user-web-games.test.js`
Expected: all tests pass.

### Task 6: Register lazy loading, start menu, and deployment assets

**Files:**
- Modify: `apps/user-web/index.html`
- Modify: `apps/user-web/Dockerfile`
- Modify: `apps/user-web/Caddyfile`
- Modify: `test/games.test.js`
- Modify: `test/user-web-games.test.js`

**Interfaces:**
- Produces: desktop window id `spider`, root selector `[data-game-root="spider"]`, and `WINDOWS.spider` metadata.
- Ensures: `spider-solitaire.js` loads before `games.js` on first game launch.

- [ ] **Step 1: Write failing shell and asset tests**

Assert `GAME_IDS` includes `spider`; `WINDOWS` has a Spider title and existing `solitaire` icon; the start menu button opens `spider`; the independent window contains difficulty/undo/hint commands and a Spider game root; Docker copies `spider-solitaire.js`; cache/version headers include it.

- [ ] **Step 2: Run focused shell tests and confirm expected failures**

Run: `node --test test/games.test.js test/user-web-games.test.js`
Expected: failures only for missing Spider registration/assets.

- [ ] **Step 3: Add the start item and independent XP window**

Reuse `./icons/solitaire.png` for title/start/taskbar. Add the difficulty commands and status root without adding a route or top navigation item.

- [ ] **Step 4: Load `spider-solitaire.js` before `games.js` in the existing lazy loader**

Create script elements sequentially so `window.ClawadSpider` exists when `games.js` mounts Spider. Reset the shared promise on either load failure.

- [ ] **Step 5: Add the engine file to production image and static cache policy**

Update explicit Docker `COPY` lines and the Caddy static JavaScript matcher beside `games.js` and Solitaire worker files.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/games.test.js test/user-web-games.test.js test/spider-solitaire.test.js`
Expected: all focused tests pass.

### Task 7: Full verification and local browser QA

**Files:**
- Verify only; modify the smallest owning file if a test exposes a defect.

**Interfaces:**
- Consumes the complete feature and validates user-visible behavior.

- [ ] **Step 1: Run syntax checks**

Run: `npm.cmd run lint`
Expected: exit 0 and `lint 통과`.

- [ ] **Step 2: Run the entire test suite**

Run: `npm.cmd test`
Expected: exit 0, 0 failures.

- [ ] **Step 3: Start the local static server**

Run the repository's existing user-web preview command on `127.0.0.1:4173`; if no active process serves the current worktree, use the documented local server command rather than adding a package.

- [ ] **Step 4: Browser-check the drag regression**

Open Classic Solitaire, grab a face-up card near its center, drag it over a legal destination, and verify the same point stays under the pointer and the visually aligned card drops successfully.

- [ ] **Step 5: Browser-check all Spider difficulty and command paths**

Start 1-, 2-, and 4-suit games; verify 10 columns and five stock deals. Check one card move, same-suit run move, empty-column stock rejection, `H`, repeated `Ctrl+Z`, score/move changes, close/reopen, minimize/resume, and resizable-window behavior.

- [ ] **Step 6: Inspect only scoped changes**

Run: `git diff --check -- apps/user-web/games.js apps/user-web/spider-solitaire.js apps/user-web/index.html apps/user-web/Dockerfile apps/user-web/Caddyfile test/spider-solitaire.test.js test/user-web-games.test.js test/games.test.js docs/superpowers`

Run: `git status --short --branch`

Expected: only the planned application/test/docs files plus the pre-existing unrelated Graphify cache changes; no commit or push.
