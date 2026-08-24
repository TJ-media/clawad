'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  createSeededRandom,
  createVerifiedDeal,
  createVerifiedFallback,
  dealFingerprint,
  solveKlondike,
} = require('../apps/user-web/solitaire-solver.js');
const {
  drawStock,
  isKlondikeWon,
  moveCardToFoundation,
  moveCardToTableau,
  moveTableauRun,
} = require('../apps/user-web/games.js');

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];

function cardId(cardNumber) {
  return `${SUITS[Math.floor(cardNumber / 13)]}-${(cardNumber % 13) + 1}`;
}

function exposeStockCard(state, expectedId) {
  for (let click = 0; click < 110; click += 1) {
    if (state.waste.at(-1)?.id === expectedId) return true;
    drawStock(state);
  }
  return false;
}

function replayProof(initial, moves) {
  const state = structuredClone(initial);
  for (const move of moves) {
    if (move.from === 'stock') {
      if (!exposeStockCard(state, cardId(move.card))) return false;
      if (move.to === 'foundation') {
        if (!moveCardToFoundation(state, { zone: 'waste' }, Math.floor(move.card / 13))) return false;
      } else if (!moveCardToTableau(state, { zone: 'waste' }, move.target)) {
        return false;
      }
    } else if (move.to === 'foundation') {
      if (!moveCardToFoundation(state, { zone: 'tableau', column: move.column }, Math.floor(move.card / 13))) {
        return false;
      }
    } else if (!moveTableauRun(state, move.column, move.start, move.target)) {
      return false;
    }
  }
  return isKlondikeWon(state);
}

test('솔버가 승인한 딜에는 실제 승리 경로 증명이 있다 (CLAW-278)', () => {
  const generated = createVerifiedDeal({
    random: createSeededRandom(278),
    timeBudgetMs: 1000,
  });

  assert.ok(generated, '1초 안에 검증된 딜을 하나 만들어야 한다');
  assert.ok(generated.proof.moves.length > 0, '승리 가능 판정에는 빈 불리언이 아니라 이동 경로가 있어야 한다');
  assert.ok(replayProof(generated.state, generated.proof.moves),
    '솔버 경로를 실제 게임 이동 함수로 재생했을 때 52장이 파운데이션에 올라가야 한다');
  assert.strictEqual(solveKlondike(generated.state, { timeBudgetMs: 1000 }).solved, true);
});

test('같은 세션에서 이미 제공한 딜은 다시 승인하지 않는다 (CLAW-278)', () => {
  const first = createVerifiedDeal({
    random: createSeededRandom(278),
    timeBudgetMs: 1000,
  });
  const second = createVerifiedDeal({
    random: createSeededRandom(278),
    excluded: new Set([first.fingerprint]),
    timeBudgetMs: 1000,
  });

  assert.ok(second);
  assert.notStrictEqual(second.fingerprint, first.fingerprint);
  assert.strictEqual(dealFingerprint(first.state), first.fingerprint);
  assert.strictEqual(dealFingerprint(second.state), second.fingerprint);
});

test('런타임 솔버가 시간 안에 못 끝나도 사전 검증 예비 딜만 사용한다 (CLAW-278)', () => {
  const excluded = new Set();
  for (let index = 0; index < 10; index += 1) {
    const fallback = createVerifiedFallback(excluded);
    assert.ok(fallback);
    const proof = solveKlondike(fallback.state, { timeBudgetMs: 1000 });
    assert.ok(proof.solved, `예비 딜 ${index + 1}도 승리 경로가 있어야 한다`);
    assert.ok(replayProof(fallback.state, proof.moves),
      `예비 딜 ${index + 1}의 경로를 실제 게임 이동으로 재생할 수 있어야 한다`);
    excluded.add(fallback.fingerprint);
  }
});

test('검증된 딜 생성은 브라우저 UI를 막지 않도록 워커 파일로 배포된다 (CLAW-278)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const workerPath = path.join(__dirname, '..', 'apps', 'user-web', 'solitaire-worker.js');
  assert.ok(fs.existsSync(workerPath));
  assert.match(fs.readFileSync(workerPath, 'utf8'), /createVerifiedDeal/);
});
