'use strict';

importScripts('./spider-solitaire.js', './spider-solver.js');

let handled = false;

self.addEventListener('message', (event) => {
  if (handled || event.data?.type !== 'solve') return;
  handled = true;

  const request = event.data;
  const result = self.ClawadSpiderSolver.solveSpiderSeed(request.difficulty, request.seed, {
    timeoutMs: request.timeoutMs,
    maxNodes: request.maxNodes,
  });
  self.postMessage({ type: 'result', requestId: request.requestId, result });
  self.close();
});
