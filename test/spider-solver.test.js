'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  spiderPositionKey,
  listSpiderSolverActions,
  solveSpiderState,
} = require('../apps/user-web/spider-solver.js');
const { applySpiderAction, isSpiderWon } = require('../apps/user-web/spider-solitaire.js');

let cardNumber = 0;

function card(id, suit, rank, faceUp = true) {
  cardNumber += 1;
  return { id: id || `solver-fixture-${cardNumber}`, suit, rank, faceUp };
}

function up(suit, rank) {
  return card(null, suit, rank, true);
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
