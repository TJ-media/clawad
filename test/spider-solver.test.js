'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  spiderPositionKey,
  listSpiderSolverActions,
  solveSpiderState,
  __test: solverTestApi,
} = require('../apps/user-web/spider-solver.js');
const spiderEngine = require('../apps/user-web/spider-solitaire.js');
const { applySpiderAction, isSpiderWon } = spiderEngine;

let cardNumber = 0;

function card(id, suit, rank, faceUp = true) {
  cardNumber += 1;
  return { id: id || `solver-fixture-${cardNumber}`, suit, rank, faceUp };
}

function up(suit, rank) {
  return card(null, suit, rank, true);
}

function down(suit, rank) {
  return card(null, suit, rank, false);
}

function stockLaneCards() {
  return Array.from({ length: 10 }, (_, index) => down('diamonds', index + 1));
}

function solverFixture(overrides = {}) {
  return {
    difficulty: 1,
    tableau: Array.from({ length: 10 }, () => []),
    stock: [],
    completed: [],
    score: 500,
    moves: 0,
    history: [],
    won: false,
    ...overrides,
  };
}

function descendingSuit(suit, highest, lowest) {
  return Array.from({ length: highest - lowest + 1 }, (_, index) => up(suit, highest - index));
}

function oneMoveWinFixture() {
  return solverFixture({
    tableau: [descendingSuit('spades', 13, 2), [up('spades', 1)], ...Array.from({ length: 8 }, () => [])],
    completed: Array(7).fill('hearts'),
  });
}

function noWinFiniteFixture() {
  return solverFixture({
    tableau: [[up('spades', 13)], ...Array.from({ length: 9 }, () => [])],
  });
}

function replayFixtureActions(initialState, actions) {
  const state = structuredClone(initialState);
  for (const action of actions) {
    if (!applySpiderAction(state, action)) return { won: false, state };
  }
  return { won: isSpiderWon(state), state };
}

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

test('재고가 남으면 열 교환은 다음 배포 레인이 달라 서로 다른 상태다 (CLAW-279)', () => {
  const sharedColumns = Array.from({ length: 8 }, () => [up('clubs', 13)]);
  const stock = stockLaneCards();
  const left = solverFixture({
    tableau: [[up('spades', 8)], [up('hearts', 9)], ...structuredClone(sharedColumns)],
    stock: structuredClone(stock),
  });
  const right = solverFixture({
    tableau: [[up('hearts', 9)], [up('spades', 8)], ...structuredClone(sharedColumns)],
    stock: structuredClone(stock),
  });

  assert.notStrictEqual(spiderPositionKey(left), spiderPositionKey(right));
});

test('재고가 남으면 빈 목적지별 후속 배포 레인을 보존해 모두 열거한다 (CLAW-279)', () => {
  const state = solverFixture({
    tableau: [
      [up('spades', 8)],
      [],
      [],
      [up('hearts', 9)],
      ...Array.from({ length: 6 }, () => [up('clubs', 13)]),
    ],
    stock: stockLaneCards(),
  });
  const emptyMoves = listSpiderSolverActions(state)
    .filter((action) => action.type === 'move' && action.fromColumn === 0 && action.fromIndex === 0
      && action.toColumn !== 3);

  assert.deepStrictEqual(new Set(emptyMoves.map((action) => action.toColumn)), new Set([1, 2]));
});

test('재고가 남은 빈 목적지별 successor는 canonical key도 구분한다 (CLAW-279)', () => {
  const state = solverFixture({
    tableau: [
      [up('spades', 8)],
      [],
      [],
      [up('hearts', 9)],
      ...Array.from({ length: 6 }, () => [up('clubs', 13)]),
    ],
    stock: stockLaneCards(),
  });
  const moveToFirstLane = structuredClone(state);
  const moveToSecondLane = structuredClone(state);
  assert.ok(applySpiderAction(moveToFirstLane, { type: 'move', fromColumn: 0, fromIndex: 0, toColumn: 1 }));
  assert.ok(applySpiderAction(moveToSecondLane, { type: 'move', fromColumn: 0, fromIndex: 0, toColumn: 2 }));

  assert.notStrictEqual(spiderPositionKey(moveToFirstLane), spiderPositionKey(moveToSecondLane));
});

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

test('취소 신호는 다음 상태 확장 전에 timeout으로 중단한다 (CLAW-279)', () => {
  const result = solveSpiderState(oneMoveWinFixture(), { shouldCancel: () => true });
  assert.deepStrictEqual({ status: result.status, visitedNodes: result.visitedNodes }, {
    status: 'timeout',
    visitedNodes: 0,
  });
});

test('재생 검증 실패 후보는 solved로 반환하지 않고 실패 횟수를 센다 (CLAW-279)', () => {
  const originalIsSpiderWon = spiderEngine.isSpiderWon;
  let winningChecks = 0;
  spiderEngine.isSpiderWon = (state) => {
    if (!originalIsSpiderWon(state)) return false;
    winningChecks += 1;
    return winningChecks % 2 === 1;
  };

  try {
    const result = solveSpiderState(oneMoveWinFixture(), {
      timeoutMs: 1000,
      maxNodes: 1000,
      shouldCancel: () => solverTestApi.replayFailures > 0,
    });
    assert.strictEqual(result.status, 'timeout');
    assert.strictEqual(solverTestApi.replayFailures, 1);
  } finally {
    spiderEngine.isSpiderWon = originalIsSpiderWon;
  }
});
