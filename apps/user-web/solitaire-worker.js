'use strict';

importScripts('./solitaire-solver.js');

self.addEventListener('message', (event) => {
  const excluded = new Set(Array.isArray(event.data?.excluded) ? event.data.excluded : []);
  const generated = self.ClawadSolitaireSolver.createVerifiedDeal({
    excluded,
    timeBudgetMs: 900,
  }) || self.ClawadSolitaireSolver.createVerifiedFallback(excluded);
  self.postMessage({ requestId: event.data?.requestId, generated });
});
