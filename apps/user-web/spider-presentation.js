'use strict';

(function initSpiderPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClawadSpiderPresentation = api;
})(typeof globalThis === 'object' ? globalThis : this, function createSpiderPresentation() {
  const CARD_STAGGER_MS = 28;
  const CARD_TRAVEL_MS = 360;
  const COMPLETION_LENGTH = 13;

  function isValidTableauLengths(lengths) {
    return Array.isArray(lengths)
      && lengths.every((length) => Number.isInteger(length) && length >= 0);
  }

  function calculateExpectedLengths(before, operation) {
    const lengths = Array.isArray(before && before.tableauLengths)
      ? before.tableauLengths.slice()
      : null;
    if (!isValidTableauLengths(lengths) || !operation) {
      return { valid: false, lengths: [] };
    }
    if (operation.type === 'stock') {
      return { valid: true, lengths: lengths.map((length) => length + 1) };
    }
    if (operation.type !== 'move'
      || !Number.isInteger(operation.fromColumn)
      || !Number.isInteger(operation.toColumn)
      || operation.fromColumn < 0
      || operation.toColumn < 0
      || operation.fromColumn >= lengths.length
      || operation.toColumn >= lengths.length
      || operation.fromColumn === operation.toColumn
      || !Number.isInteger(operation.movedCount)
      || operation.movedCount < 0
      || lengths[operation.fromColumn] < operation.movedCount) {
      return { valid: false, lengths: [] };
    }
    lengths[operation.fromColumn] -= operation.movedCount;
    lengths[operation.toColumn] += operation.movedCount;
    return { valid: true, lengths };
  }

  function detectSpiderCompletionEvents(before, after, operation) {
    const expected = calculateExpectedLengths(before, operation);
    const actual = Array.isArray(after && after.tableauLengths) ? after.tableauLengths : null;
    if (!expected.valid || !isValidTableauLengths(actual) || actual.length !== expected.lengths.length) return [];
    const counts = expected.lengths.map((length, column) => {
      const delta = length - actual[column];
      if (!Number.isInteger(delta) || delta < 0 || delta % COMPLETION_LENGTH !== 0) {
        return null;
      }
      return delta / COMPLETION_LENGTH;
    });
    if (counts.some((count) => count === null)) return [];

    const beforeCompleted = Array.isArray(before && before.completed) ? before.completed : [];
    const afterCompleted = Array.isArray(after && after.completed) ? after.completed : [];
    const suits = afterCompleted.slice(beforeCompleted.length);
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (suits.length < total) return [];

    const events = [];
    let suitIndex = 0;
    counts.forEach((count, column) => {
      for (let completion = 0; completion < count; completion += 1) {
        events.push({
          column,
          slotIndex: expected.lengths[column] - ((completion + 1) * COMPLETION_LENGTH),
          suit: suits[suitIndex]
        });
        suitIndex += 1;
      }
    });
    return events;
  }

  function createSpiderCompletionMotion(event, originRect, targetRect) {
    const cards = [];
    for (let index = 0; index < COMPLETION_LENGTH; index += 1) {
      cards.push({
        suit: event.suit,
        rank: COMPLETION_LENGTH - index,
        delayMs: index * CARD_STAGGER_MS,
        durationMs: CARD_TRAVEL_MS,
        fromX: originRect.left,
        fromY: originRect.top,
        toX: targetRect.left,
        toY: targetRect.top
      });
    }
    return cards;
  }

  return { detectSpiderCompletionEvents, createSpiderCompletionMotion };
});
