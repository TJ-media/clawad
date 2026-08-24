'use strict';

// 드로우 1·무제한 재딜 클론다이크 솔버 (CLAW-278).
// 브라우저에서는 Web Worker가, 테스트에서는 CommonJS가 같은 순수 계산부를 사용한다.
(function exposeSolitaireSolver(root, factory) {
  const solver = factory();
  if (typeof module === 'object' && module.exports) module.exports = solver;
  if (root) root.ClawadSolitaireSolver = solver;
})(typeof globalThis === 'object' ? globalThis : this, function createSolitaireSolver() {
  const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
  const RANK_COUNT = 13;
  const DEFAULT_NODE_LIMIT = 60000;
  const DEFAULT_ATTEMPT_MS = 140;
  // 각 seed의 승리 경로는 test/solitaire-solver.test.js가 실제 게임 함수로 재생 검증한다.
  // 런타임 탐색이 느린 기기에서도 미검증 딜이나 무한 계산으로 떨어지지 않는 최후 수단이다.
  const VERIFIED_FALLBACK_SEEDS = [278, 282, 289, 293, 302, 303, 305, 306, 307, 309];

  function nowMs() {
    return typeof performance === 'object' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function createSeededRandom(seed) {
    let value = seed >>> 0;
    return function seededRandom() {
      value += 0x6D2B79F5;
      let mixed = value;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffledDeck(random) {
    const deck = [];
    for (const suitName of SUITS) {
      for (let cardRank = 1; cardRank <= RANK_COUNT; cardRank += 1) {
        deck.push({
          id: `${suitName}-${cardRank}`,
          suit: suitName,
          rank: cardRank,
          faceUp: false,
        });
      }
    }
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
    }
    return deck;
  }

  function dealKlondike(random = Math.random) {
    const deck = shuffledDeck(random);
    const tableau = Array.from({ length: 7 }, () => []);
    for (let column = 0; column < tableau.length; column += 1) {
      for (let row = 0; row <= column; row += 1) {
        const card = deck.pop();
        card.faceUp = row === column;
        tableau[column].push(card);
      }
    }
    return {
      stock: deck,
      waste: [],
      foundations: Array.from({ length: 4 }, () => []),
      tableau,
      moves: 0,
      won: false,
    };
  }

  function dealFingerprint(state) {
    const stock = state.stock.map((card) => card.id).join(',');
    const tableau = state.tableau.map((pile) => pile.map((card) => card.id).join(',')).join('|');
    return `${stock}/${tableau}`;
  }

  function cardNumber(card) {
    return SUITS.indexOf(card.suit) * RANK_COUNT + card.rank - 1;
  }

  function cardSuit(card) {
    return Math.floor(card / RANK_COUNT);
  }

  function cardRank(card) {
    return (card % RANK_COUNT) + 1;
  }

  function cardColor(card) {
    const suit = cardSuit(card);
    return suit === 1 || suit === 2 ? 1 : 0;
  }

  function canStack(card, target) {
    if (target === undefined) return cardRank(card) === 13;
    return cardColor(card) !== cardColor(target) && cardRank(card) + 1 === cardRank(target);
  }

  function solverState(state) {
    return {
      tableau: state.tableau.map((pile) => ({
        cards: pile.map(cardNumber),
        hidden: pile.findIndex((card) => card.faceUp) < 0
          ? pile.length
          : pile.findIndex((card) => card.faceUp),
      })),
      // 드로우 1에 재딜 제한이 없으면 남은 스톡·웨이스트의 모든 카드는 유한 번의
      // 넘기기로 다시 맨 위에 온다. 따라서 순환 클릭을 상태로 늘리지 않고 한 묶음으로 푼다.
      reserve: [...state.stock, ...state.waste].map(cardNumber),
      foundations: SUITS.map((suitName) => {
        const pile = state.foundations.find((candidate) => candidate[0]?.suit === suitName);
        return pile?.at(-1)?.rank || 0;
      }),
    };
  }

  function cloneState(state) {
    return {
      tableau: state.tableau.map((pile) => ({ cards: pile.cards.slice(), hidden: pile.hidden })),
      reserve: state.reserve.slice(),
      foundations: state.foundations.slice(),
    };
  }

  function exposeTop(pile) {
    if (pile.cards.length === pile.hidden && pile.hidden > 0) pile.hidden -= 1;
  }

  function stateKey(state) {
    const tableau = state.tableau
      .map((pile) => `${pile.hidden}:${pile.cards.join('.')}`)
      .sort()
      .join('|');
    const reserve = state.reserve.slice().sort((left, right) => left - right).join('.');
    return `${state.foundations.join('.')}/${reserve}/${tableau}`;
  }

  function stateScore(state) {
    const foundations = state.foundations.reduce((total, value) => total + value, 0);
    const hidden = state.tableau.reduce((total, pile) => total + pile.hidden, 0);
    return foundations * 100 - hidden * 18 - state.reserve.length;
  }

  function appendFoundationMoves(state, moves) {
    for (let column = 0; column < state.tableau.length; column += 1) {
      const pile = state.tableau[column];
      if (pile.cards.length <= pile.hidden) continue;
      const card = pile.cards.at(-1);
      const suit = cardSuit(card);
      if (cardRank(card) !== state.foundations[suit] + 1) continue;
      const next = cloneState(state);
      next.tableau[column].cards.pop();
      exposeTop(next.tableau[column]);
      next.foundations[suit] += 1;
      moves.push({
        state: next,
        move: { from: 'tableau', column, to: 'foundation', card },
        priority: pile.cards.length - 1 === pile.hidden ? 1200 : 900,
      });
    }

    for (let index = 0; index < state.reserve.length; index += 1) {
      const card = state.reserve[index];
      const suit = cardSuit(card);
      if (cardRank(card) !== state.foundations[suit] + 1) continue;
      const next = cloneState(state);
      next.reserve.splice(index, 1);
      next.foundations[suit] += 1;
      moves.push({
        state: next,
        move: { from: 'stock', to: 'foundation', card },
        priority: 850,
      });
    }
  }

  function appendTableauMoves(state, moves) {
    for (let source = 0; source < state.tableau.length; source += 1) {
      const sourcePile = state.tableau[source];
      for (let start = sourcePile.hidden; start < sourcePile.cards.length; start += 1) {
        const card = sourcePile.cards[start];
        for (let target = 0; target < state.tableau.length; target += 1) {
          if (source === target) continue;
          const targetPile = state.tableau[target];
          const targetTop = targetPile.cards.at(-1);
          if (!canStack(card, targetTop)) continue;
          // 완전히 공개된 킹 묶음을 빈 열 사이로 옮기는 것은 같은 상태의 이름만 바꾼다.
          if (targetTop === undefined && start === 0 && sourcePile.hidden === 0) continue;
          const next = cloneState(state);
          const moving = next.tableau[source].cards.splice(start);
          exposeTop(next.tableau[source]);
          next.tableau[target].cards.push(...moving);
          moves.push({
            state: next,
            move: { from: 'tableau', column: source, start, to: 'tableau', target, cards: moving.slice() },
            priority: start === sourcePile.hidden && sourcePile.hidden > 0 ? 1100 : 250 + moving.length,
          });
        }
      }
    }

    for (let index = 0; index < state.reserve.length; index += 1) {
      const card = state.reserve[index];
      for (let target = 0; target < state.tableau.length; target += 1) {
        const targetPile = state.tableau[target];
        const targetTop = targetPile.cards.at(-1);
        if (!canStack(card, targetTop)) continue;
        const next = cloneState(state);
        next.reserve.splice(index, 1);
        next.tableau[target].cards.push(card);
        moves.push({
          state: next,
          move: { from: 'stock', to: 'tableau', target, card },
          priority: targetTop === undefined ? 550 : 400,
        });
      }
    }
  }

  function solveKlondike(initial, options = {}) {
    const startedAt = nowMs();
    const timeBudgetMs = Math.max(1, options.timeBudgetMs || DEFAULT_ATTEMPT_MS);
    const nodeLimit = Math.max(1, options.nodeLimit || DEFAULT_NODE_LIMIT);
    const seen = new Set();
    const trail = [];
    let nodes = 0;
    let timedOut = false;

    function visit(state) {
      nodes += 1;
      if (nodes > nodeLimit || nowMs() - startedAt > timeBudgetMs) {
        timedOut = true;
        return false;
      }
      if (state.foundations.reduce((total, value) => total + value, 0) === 52) return true;
      const key = stateKey(state);
      if (seen.has(key)) return false;
      seen.add(key);

      const moves = [];
      appendFoundationMoves(state, moves);
      appendTableauMoves(state, moves);
      moves.sort((left, right) => {
        const priority = right.priority - left.priority;
        return priority || stateScore(right.state) - stateScore(left.state);
      });
      for (const move of moves) {
        trail.push(move.move);
        if (visit(move.state)) return true;
        trail.pop();
        if (timedOut) return false;
      }
      return false;
    }

    const solved = visit(solverState(initial));
    return {
      solved,
      moves: solved ? trail.slice() : [],
      nodes,
      elapsedMs: nowMs() - startedAt,
      timedOut,
    };
  }

  function createVerifiedDeal(options = {}) {
    const random = options.random || Math.random;
    const excluded = options.excluded || new Set();
    const timeBudgetMs = Math.max(1, options.timeBudgetMs || 900);
    const startedAt = nowMs();
    let attempts = 0;

    while (nowMs() - startedAt < timeBudgetMs) {
      const state = dealKlondike(random);
      const fingerprint = dealFingerprint(state);
      if (excluded.has(fingerprint)) continue;
      attempts += 1;
      const remainingMs = timeBudgetMs - (nowMs() - startedAt);
      const proof = solveKlondike(state, {
        timeBudgetMs: Math.min(DEFAULT_ATTEMPT_MS, remainingMs),
        nodeLimit: DEFAULT_NODE_LIMIT,
      });
      if (proof.solved) {
        return {
          state,
          fingerprint,
          proof,
          attempts,
          elapsedMs: nowMs() - startedAt,
        };
      }
    }
    return null;
  }

  function createVerifiedFallback(excluded = new Set()) {
    for (const seed of VERIFIED_FALLBACK_SEEDS) {
      const state = dealKlondike(createSeededRandom(seed));
      const fingerprint = dealFingerprint(state);
      if (excluded.has(fingerprint)) continue;
      return {
        state,
        fingerprint,
        proof: { preverified: true, seed, moves: [] },
        attempts: 0,
        elapsedMs: 0,
      };
    }
    return null;
  }

  return {
    createSeededRandom,
    createVerifiedDeal,
    createVerifiedFallback,
    dealFingerprint,
    dealKlondike,
    solveKlondike,
  };
});
