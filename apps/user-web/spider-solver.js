(function spiderSolverModule(root, factory) {
  const engine = typeof module === 'object' && module.exports
    ? require('./spider-solitaire')
    : root.ClawadSpider;
  const api = factory(engine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClawadSpiderSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function spiderSolverFactory(engine) {
  'use strict';

  const SUIT_CODES = {
    clubs: 'c',
    diamonds: 'd',
    hearts: 'h',
    spades: 's',
  };
  const DEFAULT_TIMEOUT_MS = 5000;
  const DEFAULT_MAX_NODES = 100000;
  let replayFailures = 0;

  function cardEncoding(card) {
    const faceCode = card && card.faceUp ? '1' : '0';
    const suitCode = card && SUIT_CODES[card.suit] ? SUIT_CODES[card.suit] : '?';
    const rankCode = card && Number.isInteger(card.rank) ? card.rank.toString(36) : '?';
    return `${faceCode}${suitCode}${rankCode}`;
  }

  function spiderPositionKey(state) {
    const stockRemains = Array.isArray(state && state.stock) && state.stock.length > 0;
    const columns = Array.isArray(state && state.tableau)
      ? state.tableau.map((pile) => Array.isArray(pile) ? pile.map(cardEncoding).join('') : '?')
      : [];
    if (!stockRemains) columns.sort();
    const stock = Array.isArray(state && state.stock) ? state.stock.map(cardEncoding).join('') : '';
    const completedCounts = new Map();
    if (Array.isArray(state && state.completed)) {
      for (const suit of state.completed) {
        completedCounts.set(suit, (completedCounts.get(suit) || 0) + 1);
      }
    }
    const completed = Array.from(completedCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([suit, count]) => `${SUIT_CODES[suit] || '?'}${count.toString(36)}`)
      .join('');
    return `${columns.join('|')}#${stock}#${completed}`;
  }

  function isCard(card) {
    return !!card && typeof card.suit === 'string' && card.suit.length > 0
      && Number.isInteger(card.rank) && card.rank >= 1 && card.rank <= 13;
  }

  function listSpiderSolverActions(state) {
    if (!state || !Array.isArray(state.tableau)) return [];
    const actions = [];
    const stockRemains = Array.isArray(state.stock) && state.stock.length > 0;
    const firstEmptyTarget = stockRemains
      ? -1 : state.tableau.findIndex((pile) => Array.isArray(pile) && pile.length === 0);

    for (let fromColumn = 0; fromColumn < state.tableau.length; fromColumn += 1) {
      const source = state.tableau[fromColumn];
      if (!Array.isArray(source)) continue;
      for (let fromIndex = source.length - 1; fromIndex >= 0; fromIndex -= 1) {
        const card = source[fromIndex];
        if (!card || !card.faceUp) break;
        if (fromIndex < source.length - 1) {
          const below = source[fromIndex + 1];
          if (card.suit !== below.suit || card.rank !== below.rank + 1) break;
        }

        for (let toColumn = 0; toColumn < state.tableau.length; toColumn += 1) {
          if (toColumn === fromColumn) continue;
          const target = state.tableau[toColumn];
          if (!Array.isArray(target)) continue;
          if (target.length === 0) {
            if (firstEmptyTarget >= 0 && toColumn !== firstEmptyTarget) continue;
          } else {
            const targetTop = target[target.length - 1];
            if (!targetTop || !targetTop.faceUp || targetTop.rank !== card.rank + 1) continue;
          }
          actions.push({ type: 'move', fromColumn, fromIndex, toColumn });
        }
      }
    }

    const canDealStock = state.tableau.length === 10
      && state.tableau.every((pile) => Array.isArray(pile) && pile.length > 0)
      && Array.isArray(state.stock) && state.stock.length >= 10
      && state.stock.slice(0, 10).every(isCard);
    if (canDealStock) actions.push({ type: 'stock' });
    return actions;
  }

  function cloneSolverState(state) {
    const clone = JSON.parse(JSON.stringify(state));
    clone.history = [];
    return clone;
  }

  function hiddenCardCount(state) {
    if (!state || !Array.isArray(state.tableau)) return 0;
    return state.tableau.reduce((total, pile) => total + (Array.isArray(pile)
      ? pile.filter((card) => card && !card.faceUp).length : 0), 0);
  }

  function emptyColumnCount(state) {
    if (!state || !Array.isArray(state.tableau)) return 0;
    return state.tableau.filter((pile) => Array.isArray(pile) && pile.length === 0).length;
  }

  function createSuccessors(state) {
    const completedBefore = Array.isArray(state.completed) ? state.completed.length : 0;
    const hiddenBefore = hiddenCardCount(state);
    const emptyBefore = emptyColumnCount(state);
    return listSpiderSolverActions(state).map((action, order) => {
      let sameSuitExtension = 0;
      let mixedSuitMove = 0;
      if (action.type === 'move') {
        const source = state.tableau[action.fromColumn];
        const target = state.tableau[action.toColumn];
        const movedCard = source && source[action.fromIndex];
        const targetTop = target && target[target.length - 1];
        if (movedCard && targetTop) {
          sameSuitExtension = Number(movedCard.suit === targetTop.suit);
          mixedSuitMove = Number(movedCard.suit !== targetTop.suit);
        }
      }

      const nextState = cloneSolverState(state);
      if (!engine.applySpiderAction(nextState, action)) return null;
      nextState.history = [];
      return {
        action,
        state: nextState,
        order,
        completionGain: (Array.isArray(nextState.completed) ? nextState.completed.length : 0) - completedBefore,
        hiddenReduction: hiddenBefore - hiddenCardCount(nextState),
        newEmptyColumn: emptyColumnCount(nextState) - emptyBefore,
        sameSuitExtension,
        mixedSuitMove,
      };
    }).filter(Boolean).sort((left, right) => right.completionGain - left.completionGain
      || right.hiddenReduction - left.hiddenReduction
      || right.newEmptyColumn - left.newEmptyColumn
      || right.sameSuitExtension - left.sameSuitExtension
      || right.mixedSuitMove - left.mixedSuitMove
      || left.order - right.order);
  }

  function replayWins(initialState, actions) {
    const state = cloneSolverState(initialState);
    for (const action of actions) {
      if (!engine.applySpiderAction(state, action)) return false;
      state.history = [];
    }
    return engine.isSpiderWon(state);
  }

  function solverResult(status, actions, startedAt, now, visitedNodes) {
    const resultActions = status === 'solved' ? actions.slice() : [];
    return {
      status,
      actions: resultActions,
      elapsedMs: Math.max(0, now() - startedAt),
      visitedNodes,
      solutionLength: resultActions.length,
    };
  }

  function solveSpiderState(initialState, options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const maxNodes = Number.isFinite(options.maxNodes)
      ? Math.max(0, Math.floor(options.maxNodes)) : DEFAULT_MAX_NODES;
    const startedAt = now();
    const originalState = cloneSolverState(initialState);
    let visitedNodes = 0;
    replayFailures = 0;

    function limitReached() {
      return shouldCancel() || now() - startedAt >= timeoutMs || visitedNodes >= maxNodes;
    }

    for (let depthLimit = 0; ; depthLimit += 1) {
      const rootState = cloneSolverState(originalState);
      const rootKey = spiderPositionKey(rootState);
      const bestDepth = new Map([[rootKey, 0]]);
      const stack = [{ state: rootState, actions: [], depth: 0 }];
      let depthCutoff = false;

      while (stack.length > 0) {
        if (limitReached()) {
          return solverResult('timeout', [], startedAt, now, visitedNodes);
        }

        const frame = stack.pop();
        visitedNodes += 1;
        if (engine.isSpiderWon(frame.state)) {
          if (replayWins(originalState, frame.actions)) {
            return solverResult('solved', frame.actions, startedAt, now, visitedNodes);
          }
          replayFailures += 1;
          continue;
        }

        const successors = createSuccessors(frame.state);
        const nextFrames = [];
        for (const successor of successors) {
          const nextDepth = frame.depth + 1;
          const key = spiderPositionKey(successor.state);
          const previousDepth = bestDepth.get(key);
          if (previousDepth !== undefined && previousDepth <= nextDepth) continue;
          bestDepth.set(key, nextDepth);
          if (nextDepth > depthLimit) {
            depthCutoff = true;
            continue;
          }
          nextFrames.push({
            state: successor.state,
            actions: [...frame.actions, successor.action],
            depth: nextDepth,
          });
        }

        for (let index = nextFrames.length - 1; index >= 0; index -= 1) {
          stack.push(nextFrames[index]);
        }
      }

      if (!depthCutoff) {
        return solverResult('exhausted', [], startedAt, now, visitedNodes);
      }
    }
  }

  function solveSpiderSeed(difficulty, seed, options) {
    return solveSpiderState(engine.dealSpiderFromSeed(difficulty, seed), options);
  }

  const testApi = {};
  Object.defineProperty(testApi, 'replayFailures', {
    enumerable: true,
    get() {
      return replayFailures;
    },
  });

  return {
    spiderPositionKey,
    listSpiderSolverActions,
    solveSpiderState,
    solveSpiderSeed,
    __test: testApi,
  };
});
