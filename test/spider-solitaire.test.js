'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const spider = require('../apps/user-web/spider-solitaire.js');

const {
  createSpiderDeck,
  normalizeSpiderDifficulty,
  dealSpider,
  isSpiderRun,
  moveSpiderRun,
  isSpiderWon,
  dealSpiderStock,
  undoSpider,
  findSpiderHint,
  normalizeSpiderSeed,
  createSpiderSeededRandom,
  dealSpiderFromSeed,
  applySpiderAction,
  replaySpiderActions,
} = spider;

let cardNumber = 0;

function card(suit, rank, faceUp) {
  cardNumber += 1;
  return { id: `fixture-${cardNumber}`, suit, rank, faceUp };
}

function up(suit, rank) {
  return card(suit, rank, true);
}

function down(suit, rank) {
  return card(suit, rank, false);
}

function descendingSuit(suit, highest, lowest) {
  return Array.from({ length: highest - lowest + 1 }, (_, index) => up(suit, highest - index));
}

function spiderFixture(overrides) {
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

test('공개 action API는 실제 이동과 재고만 적용하고 불법 수에서 멈춘다 (CLAW-279)', () => {
  const state = spiderFixture({ tableau: [[up('spades', 8)], [up('hearts', 9)]], stock: [] });
  assert.ok(applySpiderAction(state, { type: 'move', fromColumn: 0, fromIndex: 0, toColumn: 1 }));
  assert.ok(!applySpiderAction(state, { type: 'stock' }));
});

test('해답 재생은 첫 불법 action 인덱스를 보고하고 거짓 승리를 만들지 않는다 (CLAW-279)', () => {
  const result = replaySpiderActions(1, 123, [{ type: 'move', fromColumn: 99, fromIndex: 0, toColumn: 0 }]);
  assert.deepStrictEqual({ won: result.won, failedAt: result.failedAt }, { won: false, failedAt: 0 });
});

test('난이도별로 104장을 정해진 무늬 수로 만든다 (CLAW-279)', () => {
  assert.deepStrictEqual(new Set(createSpiderDeck(1).map((card) => card.suit)), new Set(['spades']));
  assert.deepStrictEqual(new Set(createSpiderDeck(2).map((card) => card.suit)), new Set(['spades', 'hearts']));
  assert.strictEqual(new Set(createSpiderDeck(4).map((card) => card.suit)).size, 4);
  assert.strictEqual(createSpiderDeck(4).length, 104);
  assert.strictEqual(normalizeSpiderDifficulty(3), 1);
});

test('초기 판은 4개 열에 6장, 6개 열에 5장을 놓고 50장을 남긴다 (CLAW-279)', () => {
  const state = dealSpider(2, () => 0.25);
  assert.deepStrictEqual(state.tableau.map((pile) => pile.length), [6, 6, 6, 6, 5, 5, 5, 5, 5, 5]);
  assert.strictEqual(state.stock.length, 50);
  assert.ok(state.tableau.every((pile) => pile.at(-1).faceUp));
  assert.ok(state.tableau.every((pile) => pile.slice(0, -1).every((card) => !card.faceUp)));
  assert.deepStrictEqual({ score: state.score, moves: state.moves }, { score: 500, moves: 0 });
});

test('다른 무늬 위에도 한 단계 낮게 놓지만 같은 무늬 연속 묶음만 옮긴다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [
      [up('spades', 8), up('spades', 7)],
      [up('hearts', 9)],
      [up('clubs', 9), up('diamonds', 8)],
    ],
  });

  assert.strictEqual(isSpiderRun(state.tableau[0]), true);
  assert.ok(moveSpiderRun(state, 0, 0, 1));
  assert.ok(!moveSpiderRun(state, 2, 0, 1));
  assert.deepStrictEqual(state.tableau[1].map((value) => value.rank), [9, 8, 7]);
});

test('빈 열에는 같은 무늬 내림차순 묶음을 옮긴다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [[up('spades', 8), up('spades', 7)], [], []],
  });

  assert.ok(moveSpiderRun(state, 0, 0, 1));
  assert.deepStrictEqual(state.tableau[0], []);
  assert.deepStrictEqual(state.tableau[1].map((value) => value.rank), [8, 7]);
  assert.deepStrictEqual({ score: state.score, moves: state.moves, history: state.history.length }, {
    score: 499,
    moves: 1,
    history: 1,
  });
});

test('같은 열, 잘못된 인덱스, 뒤집힌 카드, 다른 무늬 묶음 이동은 거부하고 상태를 보존한다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [[down('spades', 9), up('spades', 8), up('hearts', 7)], [up('clubs', 9)]],
  });
  const before = structuredClone(state);

  assert.strictEqual(moveSpiderRun(state, 0, 1, 0), false);
  assert.strictEqual(moveSpiderRun(state, -1, 0, 1), false);
  assert.strictEqual(moveSpiderRun(state, 0, 3, 1), false);
  assert.strictEqual(moveSpiderRun(state, 0, 0, 1), false);
  assert.deepStrictEqual(state, before);
});

test('이동 뒤 원본 열의 새 맨 위 카드를 뒤집는다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [[down('spades', 9), up('spades', 8)], [up('hearts', 9)]],
  });

  assert.ok(moveSpiderRun(state, 0, 1, 1));
  assert.strictEqual(state.tableau[0][0].faceUp, true);
});

test('같은 무늬 K-A를 제거하고 100점을 더해 8묶음이면 승리한다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [descendingSuit('spades', 13, 2), [up('spades', 1)]],
    completed: Array(7).fill('hearts'),
  });

  assert.ok(moveSpiderRun(state, 1, 0, 0));
  assert.strictEqual(state.completed.length, 8);
  assert.strictEqual(state.completed.at(-1), 'spades');
  assert.strictEqual(state.score, 599);
  assert.strictEqual(state.won, true);
  assert.strictEqual(isSpiderWon(state), true);
});

test('재고에서 10장을 각 열에 앞면으로 한 장씩 배포하고 이동·점수를 기록한다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: Array.from({ length: 10 }, () => [up('clubs', 13)]),
    stock: Array.from({ length: 10 }, (_, index) => down('spades', index + 1)),
  });

  assert.deepStrictEqual(dealSpiderStock(state), { ok: true });
  assert.deepStrictEqual(state.tableau.map((pile) => pile.at(-1).rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(state.tableau.every((pile) => pile.at(-1).faceUp));
  assert.strictEqual(state.stock.length, 0);
  assert.deepStrictEqual({ score: state.score, moves: state.moves, history: state.history.length }, {
    score: 499,
    moves: 1,
    history: 1,
  });
});

test('빈 열 또는 10장 미만 재고에는 배포하지 않고 정확한 사유를 돌려준다 (CLAW-279)', () => {
  const emptyColumnState = spiderFixture({
    tableau: [[], ...Array.from({ length: 9 }, () => [up('clubs', 13)])],
    stock: Array.from({ length: 10 }, (_, index) => down('spades', index + 1)),
  });
  const shortStockState = spiderFixture({
    tableau: Array.from({ length: 10 }, () => [up('clubs', 13)]),
    stock: Array.from({ length: 9 }, (_, index) => down('spades', index + 1)),
  });
  const beforeEmpty = structuredClone(emptyColumnState);
  const beforeShort = structuredClone(shortStockState);

  assert.deepStrictEqual(dealSpiderStock(emptyColumnState), { ok: false, reason: 'EMPTY_COLUMN' });
  assert.deepStrictEqual(dealSpiderStock(shortStockState), { ok: false, reason: 'STOCK_EMPTY' });
  assert.deepStrictEqual(emptyColumnState, beforeEmpty);
  assert.deepStrictEqual(shortStockState, beforeShort);
});

test('이동과 재고 배포를 차례로 되돌리고 복원 뒤 되돌리기 비용을 적용한다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [
      [down('spades', 9), up('spades', 8)],
      [up('hearts', 9)],
      ...Array.from({ length: 8 }, () => [up('clubs', 13)]),
    ],
    stock: Array.from({ length: 10 }, (_, index) => down('diamonds', index + 1)),
  });
  const initial = structuredClone({ tableau: state.tableau, stock: state.stock, completed: state.completed });

  assert.ok(moveSpiderRun(state, 0, 1, 1));
  const afterMove = structuredClone({ tableau: state.tableau, stock: state.stock, completed: state.completed });
  assert.deepStrictEqual(dealSpiderStock(state), { ok: true });

  assert.strictEqual(undoSpider(state), true);
  assert.deepStrictEqual({ tableau: state.tableau, stock: state.stock, completed: state.completed }, afterMove);
  assert.deepStrictEqual({ score: state.score, moves: state.moves, history: state.history.length }, {
    score: 498,
    moves: 2,
    history: 1,
  });

  assert.strictEqual(undoSpider(state), true);
  assert.deepStrictEqual({ tableau: state.tableau, stock: state.stock, completed: state.completed }, initial);
  assert.deepStrictEqual({ score: state.score, moves: state.moves, history: state.history.length }, {
    score: 499,
    moves: 1,
    history: 0,
  });
  assert.strictEqual(undoSpider(state), false);
});

test('불완전한 tableau 또는 사용할 수 없는 재고는 원자적으로 재고 배포를 거부한다 (CLAW-279)', () => {
  const validStock = Array.from({ length: 10 }, (_, index) => down('spades', index + 1));
  const shortTableauState = spiderFixture({
    tableau: Array.from({ length: 9 }, () => [up('clubs', 13)]),
    stock: structuredClone(validStock),
  });
  const sparseTableauState = spiderFixture({
    tableau: Array(10),
    stock: structuredClone(validStock),
  });
  const malformedStockState = spiderFixture({
    tableau: Array.from({ length: 10 }, () => [up('clubs', 13)]),
    stock: [...structuredClone(validStock.slice(0, 9)), null],
  });
  const beforeShort = structuredClone(shortTableauState);
  const beforeSparse = structuredClone(sparseTableauState);
  const beforeMalformed = structuredClone(malformedStockState);

  assert.deepStrictEqual(dealSpiderStock(shortTableauState), { ok: false, reason: 'EMPTY_COLUMN' });
  assert.deepStrictEqual(dealSpiderStock(sparseTableauState), { ok: false, reason: 'EMPTY_COLUMN' });
  assert.deepStrictEqual(dealSpiderStock(malformedStockState), { ok: false, reason: 'STOCK_EMPTY' });
  assert.deepStrictEqual(shortTableauState, beforeShort);
  assert.deepStrictEqual(sparseTableauState, beforeSparse);
  assert.deepStrictEqual(malformedStockState, beforeMalformed);
});

test('힌트는 뒷면을 공개하는 이동을 다른 합법 이동보다 먼저 고른다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [
      [down('clubs', 9), up('spades', 8)],
      [up('hearts', 9)],
      [up('spades', 7)],
      [up('spades', 8)],
    ],
  });
  const before = structuredClone(state);

  assert.deepStrictEqual(findSpiderHint(state), { type: 'move', fromColumn: 0, fromIndex: 1, toColumn: 1 });
  assert.deepStrictEqual(state, before);
});

test('힌트는 열을 비우는 이동을 같은 무늬 연결보다 먼저 고른다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [
      [up('hearts', 8)],
      [up('clubs', 9)],
      [up('spades', 7)],
      [up('spades', 8)],
    ],
  });

  assert.deepStrictEqual(findSpiderHint(state), { type: 'move', fromColumn: 0, fromIndex: 0, toColumn: 1 });
});

test('힌트는 같은 무늬 연결을 다른 무늬 연결보다 먼저 고른다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [
      [up('hearts', 9), up('hearts', 8)],
      [up('clubs', 9)],
      [up('spades', 9), up('spades', 8)],
      [up('spades', 9)],
    ],
  });

  assert.deepStrictEqual(findSpiderHint(state), { type: 'move', fromColumn: 2, fromIndex: 1, toColumn: 3 });
});

test('힌트는 공개 효과 없는 빈 열 이동보다 다른 무늬 연결을 먼저 고른다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [
      [up('clubs', 10), up('hearts', 8)],
      [],
      [up('spades', 9)],
    ],
  });

  assert.deepStrictEqual(findSpiderHint(state), { type: 'move', fromColumn: 0, fromIndex: 1, toColumn: 2 });
});

test('힌트는 열 전체를 빈 열로 옮기는 제자리 교환보다 생산적인 같은 무늬 연결을 먼저 고른다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [
      [up('hearts', 5)],
      [],
      [up('clubs', 10), up('spades', 8)],
      [up('spades', 9)],
    ],
  });

  assert.deepStrictEqual(findSpiderHint(state), { type: 'move', fromColumn: 2, fromIndex: 1, toColumn: 3 });
});

test('힌트는 다른 무늬 연결만 가능하면 열·인덱스 순으로 고른다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: [
      [up('hearts', 8)],
      [up('spades', 9)],
      [up('clubs', 8)],
      [up('diamonds', 9)],
    ],
  });

  assert.deepStrictEqual(findSpiderHint(state), { type: 'move', fromColumn: 0, fromIndex: 0, toColumn: 1 });
});

test('힌트는 카드 이동이 없고 배포가 합법이면 재고를 제안한다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: Array.from({ length: 10 }, () => [up('clubs', 13)]),
    stock: Array.from({ length: 10 }, (_, index) => down('spades', index + 1)),
  });

  assert.deepStrictEqual(findSpiderHint(state), { type: 'stock' });
});

test('힌트는 합법 이동과 합법 재고 배포가 모두 없으면 null을 돌려준다 (CLAW-279)', () => {
  const state = spiderFixture({
    tableau: Array.from({ length: 10 }, () => [up('clubs', 13)]),
    stock: Array.from({ length: 9 }, (_, index) => down('spades', index + 1)),
  });

  assert.strictEqual(findSpiderHint(state), null);
});
