'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectSpiderCompletionEvents,
  createSpiderCompletionMotion
} = require('../apps/user-web/spider-presentation.js');

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

test('길이 차이가 13장의 정수가 아니면 완료 이벤트를 만들지 않는다 (CLAW-279)', () => {
  const before = { tableauLengths: [12], completed: [] };
  const after = { tableauLengths: [2], completed: ['clubs'] };
  assert.deepStrictEqual(detectSpiderCompletionEvents(before, after, { type: 'stock' }), []);
});

test('완성 모션은 K부터 A까지 13장을 28ms 간격으로 같은 슬롯에 보낸다 (CLAW-279)', () => {
  const cards = createSpiderCompletionMotion(
    { suit: 'hearts' }, { left: 400, top: 220 }, { left: 24, top: 610 });
  assert.deepStrictEqual(cards.map((card) => card.rank), [13,12,11,10,9,8,7,6,5,4,3,2,1]);
  assert.deepStrictEqual(cards.map((card) => card.delayMs), Array.from({ length: 13 }, (_, i) => i * 28));
  assert.ok(cards.every((card) => card.durationMs === 360 && card.toX === 24 && card.toY === 610));
  assert.ok(cards.every((card) => card.fromX === 400 && card.fromY === 220 && card.suit === 'hearts'));
});
