'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const evaluator = require('../public/evaluator.js');

test('scoreToPercent maps centipawns to sensible win percentages', () => {
  assert.equal(evaluator.scoreToPercent('cp', 0), 50);
  assert.ok(evaluator.scoreToPercent('cp', 150) > 60);
  assert.ok(evaluator.scoreToPercent('cp', -150) < 40);
  assert.equal(evaluator.scoreToPercent('mate', 3), 98);
  assert.equal(evaluator.scoreToPercent('mate', -2), 2);
});

test('formatScore formats centipawns and mates', () => {
  assert.equal(evaluator.formatScore('cp', 0), '0.0');
  assert.equal(evaluator.formatScore('cp', 150), '+1.5');
  assert.equal(evaluator.formatScore('cp', -230), '-2.3');
  assert.equal(evaluator.formatScore('mate', 3), '+M3');
  assert.equal(evaluator.formatScore('mate', -1), '-M1');
});

test('parseScore parses UCI info lines relative to turn', () => {
  // White to move, White winning by 120 cp (+1.2)
  const lineW = 'info depth 6 score cp 120 nodes 400 pv e2e4';
  const parsedW = evaluator.parseScore(lineW, 'w');
  assert.equal(parsedW.type, 'cp');
  assert.equal(parsedW.val, 120);
  assert.equal(parsedW.whiteVal, 120);
  assert.equal(parsedW.text, '+1.2');
  assert.ok(parsedW.percent > 60);

  // Black to move, Black winning by 250 cp (-2.5 for White)
  const lineB = 'info depth 6 score cp 250 nodes 400 pv d7d5';
  const parsedB = evaluator.parseScore(lineB, 'b');
  assert.equal(parsedB.type, 'cp');
  assert.equal(parsedB.val, 250);
  assert.equal(parsedB.whiteVal, -250);
  assert.equal(parsedB.text, '-2.5');
  assert.ok(parsedB.percent < 30);

  // Black to move, Black has mate in 2 (-M2 for White)
  const lineMate = 'info depth 4 score mate 2 nodes 100 pv d1h1';
  const parsedMate = evaluator.parseScore(lineMate, 'b');
  assert.equal(parsedMate.type, 'mate');
  assert.equal(parsedMate.whiteVal, -2);
  assert.equal(parsedMate.text, '-M2');
  assert.equal(parsedMate.percent, 2);

  // Non-score lines return null
  assert.equal(evaluator.parseScore('info string hash 16', 'w'), null);
  assert.equal(evaluator.parseScore(null, 'w'), null);
});

test('parseBestMove parses UCI move notations', () => {
  const m1 = evaluator.parseBestMove('bestmove e2e4');
  assert.deepEqual(m1.from, [6, 4]); // e2
  assert.deepEqual(m1.to, [4, 4]);   // e4
  assert.equal(m1.promo, null);
  assert.equal(m1.fromStr, 'e2');
  assert.equal(m1.toStr, 'e4');

  const m2 = evaluator.parseBestMove('bestmove e7e8q');
  assert.deepEqual(m2.from, [1, 4]); // e7
  assert.deepEqual(m2.to, [0, 4]);   // e8
  assert.equal(m2.promo, 'Q');

  assert.equal(evaluator.parseBestMove('info depth 1'), null);
});
