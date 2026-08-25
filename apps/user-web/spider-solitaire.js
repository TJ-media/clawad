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

  function normalizeSpiderDifficulty(value) {
    return value === 2 || value === 4 ? value : 1;
  }

  function createSpiderDeck(difficulty) {
    const normalized = normalizeSpiderDifficulty(difficulty);
    const suits = SUITS_BY_DIFFICULTY[normalized];
    const copiesPerRank = 8 / suits.length;
    const deck = [];
    let copyIndex = 0;
    for (const suit of suits) {
      for (let copy = 0; copy < copiesPerRank; copy += 1) {
        copyIndex += 1;
        for (let rank = 1; rank <= 13; rank += 1) {
          deck.push({
            id: `${copyIndex}-${suit}-${rank}`,
            suit,
            rank,
            faceUp: false,
          });
        }
      }
    }
    return deck;
  }

  function shuffle(cards, random) {
    for (let index = cards.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      const current = cards[index];
      cards[index] = cards[swapIndex];
      cards[swapIndex] = current;
    }
    return cards;
  }

  function dealSpider(difficulty, random) {
    const normalized = normalizeSpiderDifficulty(difficulty);
    const randomSource = typeof random === 'function' ? random : Math.random;
    const deck = shuffle(createSpiderDeck(normalized), randomSource);
    const tableau = Array.from({ length: 10 }, () => []);
    let dealt = 0;
    for (let pileIndex = 0; pileIndex < tableau.length; pileIndex += 1) {
      const pileSize = pileIndex < 4 ? 6 : 5;
      for (let cardIndex = 0; cardIndex < pileSize; cardIndex += 1) {
        const card = deck[dealt];
        dealt += 1;
        card.faceUp = cardIndex === pileSize - 1;
        tableau[pileIndex].push(card);
      }
    }
    return {
      difficulty: normalized,
      tableau,
      stock: deck.slice(dealt),
      completed: [],
      score: 500,
      moves: 0,
      history: [],
      won: false,
    };
  }

  function isSpiderRun(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return false;
    const suit = cards[0] && cards[0].suit;
    return cards.every((card, index) => {
      if (!card || card.suit !== suit || !Number.isInteger(card.rank)) return false;
      return index === 0 || cards[index - 1].rank === card.rank + 1;
    });
  }

  function isSpiderCard(card) {
    return !!card && typeof card === 'object'
      && typeof card.suit === 'string' && card.suit.length > 0
      && Number.isInteger(card.rank) && card.rank >= 1 && card.rank <= 13;
  }

  function snapshotSpider(state) {
    return JSON.parse(JSON.stringify({
      difficulty: state.difficulty,
      tableau: state.tableau,
      stock: state.stock,
      completed: state.completed,
      score: state.score,
      moves: state.moves,
      won: state.won,
    }));
  }

  function revealTop(pile) {
    if (pile.length > 0) pile[pile.length - 1].faceUp = true;
  }

  function isCompletedRun(cards) {
    if (!Array.isArray(cards) || cards.length !== 13 || !isSpiderRun(cards)) return false;
    return cards.every((card, index) => card.faceUp && card.rank === 13 - index);
  }

  function removeCompletedRuns(state) {
    for (const pile of state.tableau) {
      while (isCompletedRun(pile.slice(-13))) {
        const completedRun = pile.splice(-13);
        state.completed.push(completedRun[0].suit);
        state.score += 100;
        revealTop(pile);
      }
    }
    state.won = state.completed.length >= 8;
  }

  function isSpiderWon(state) {
    return !!state && Array.isArray(state.completed) && state.completed.length >= 8;
  }

  function moveSpiderRun(state, fromColumn, fromIndex, toColumn) {
    if (!state || !Array.isArray(state.tableau)
      || !Number.isInteger(fromColumn) || !Number.isInteger(fromIndex) || !Number.isInteger(toColumn)
      || fromColumn < 0 || toColumn < 0
      || fromColumn >= state.tableau.length || toColumn >= state.tableau.length
      || fromColumn === toColumn) return false;

    const source = state.tableau[fromColumn];
    const target = state.tableau[toColumn];
    if (!Array.isArray(source) || !Array.isArray(target)
      || fromIndex < 0 || fromIndex >= source.length) return false;

    const run = source.slice(fromIndex);
    const targetTop = target[target.length - 1];
    if (!run.every((card) => card && card.faceUp) || !isSpiderRun(run)
      || (targetTop && (!targetTop.faceUp || targetTop.rank !== run[0].rank + 1))) return false;

    state.history.push(snapshotSpider(state));
    target.push(...source.splice(fromIndex));
    revealTop(source);
    state.score = Math.max(0, state.score - 1);
    state.moves += 1;
    removeCompletedRuns(state);
    return true;
  }

  function dealSpiderStock(state) {
    const tableauPiles = state && Array.isArray(state.tableau)
      ? Array.from({ length: 10 }, (_, index) => state.tableau[index])
      : [];
    if (!state || !Array.isArray(state.tableau) || state.tableau.length !== 10
      || tableauPiles.some((pile) => !Array.isArray(pile) || pile.length === 0)) {
      return { ok: false, reason: 'EMPTY_COLUMN' };
    }
    const stockCards = state && Array.isArray(state.stock)
      ? Array.from({ length: 10 }, (_, index) => state.stock[index])
      : [];
    if (!Array.isArray(state.stock) || state.stock.length < 10
      || !stockCards.every(isSpiderCard)) {
      return { ok: false, reason: 'STOCK_EMPTY' };
    }

    state.history.push(snapshotSpider(state));
    const dealtCards = state.stock.splice(0, 10);
    dealtCards.forEach((card, index) => {
      card.faceUp = true;
      state.tableau[index].push(card);
    });
    state.score = Math.max(0, state.score - 1);
    state.moves += 1;
    removeCompletedRuns(state);
    return { ok: true };
  }

  function findSpiderHint(state) {
    if (!state || !Array.isArray(state.tableau)) return null;

    const moves = [];
    for (let fromColumn = 0; fromColumn < state.tableau.length; fromColumn += 1) {
      const source = state.tableau[fromColumn];
      if (!Array.isArray(source)) continue;

      for (let fromIndex = 0; fromIndex < source.length; fromIndex += 1) {
        const run = source.slice(fromIndex);
        if (!run.every((card) => card && card.faceUp) || !isSpiderRun(run)) continue;

        for (let toColumn = 0; toColumn < state.tableau.length; toColumn += 1) {
          if (fromColumn === toColumn) continue;
          const target = state.tableau[toColumn];
          if (!Array.isArray(target)) continue;
          const targetTop = target[target.length - 1];
          if (targetTop && (!targetTop.faceUp || targetTop.rank !== run[0].rank + 1)) continue;

          const revealsHiddenCard = fromIndex > 0 && !source[fromIndex - 1].faceUp;
          const createsEmptyColumn = fromIndex === 0 && Boolean(targetTop);
          const priority = revealsHiddenCard || createsEmptyColumn
            ? 0
            : targetTop && targetTop.suit === run[0].suit ? 1 : targetTop ? 2 : 3;
          moves.push({ priority, fromColumn, fromIndex, toColumn });
        }
      }
    }

    moves.sort((left, right) => left.priority - right.priority
      || left.fromColumn - right.fromColumn
      || left.fromIndex - right.fromIndex
      || left.toColumn - right.toColumn);
    if (moves.length > 0) {
      const move = moves[0];
      return { type: 'move', fromColumn: move.fromColumn, fromIndex: move.fromIndex, toColumn: move.toColumn };
    }

    const canDealStock = state.tableau.length === 10
      && state.tableau.every((pile) => Array.isArray(pile) && pile.length > 0)
      && Array.isArray(state.stock) && state.stock.length >= 10;
    return canDealStock ? { type: 'stock' } : null;
  }

  function undoSpider(state) {
    if (!state || !Array.isArray(state.history) || state.history.length === 0) return false;
    const snapshot = state.history.pop();
    if (!snapshot) return false;

    state.difficulty = snapshot.difficulty;
    state.tableau = snapshot.tableau;
    state.stock = snapshot.stock;
    state.completed = snapshot.completed;
    state.score = Math.max(0, snapshot.score - 1);
    state.moves = snapshot.moves + 1;
    state.won = snapshot.won;
    return true;
  }

  return {
    normalizeSpiderDifficulty,
    createSpiderDeck,
    dealSpider,
    isSpiderRun,
    moveSpiderRun,
    dealSpiderStock,
    findSpiderHint,
    undoSpider,
    isSpiderWon,
  };
});
