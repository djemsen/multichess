'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chess = require('../public/engine.js');

function play(game, from, to, promo) {
  const move = chess.findLegalMove(game, from, to, promo);
  assert.ok(move, `expected ${from} -> ${to} to be legal`);
  const san = chess.makeMove(game, move);
  return { move, san };
}

function emptyGame() {
  const game = chess.createGame();
  game.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  game.castling = { wK: false, wQ: false, bK: false, bQ: false };
  game.ep = null;
  return game;
}

test('initial position has 20 legal moves', () => {
  const game = chess.createGame();
  assert.equal(chess.allLegalMoves(game.board, 'w', game.castling, game.ep).length, 20);
  assert.equal(chess.allLegalMoves(game.board, 'b', game.castling, game.ep).length, 20);
});

test('fool\'s mate is detected as checkmate', () => {
  const game = chess.createGame();
  play(game, [6, 5], [5, 5]); // f3
  play(game, [1, 4], [3, 4]); // e5
  play(game, [6, 6], [4, 6]); // g4
  const { san } = play(game, [0, 3], [4, 7]); // Qh4#

  assert.equal(san, 'Qh4#');
  assert.equal(game.over, true);
  assert.equal(game.inCheck, true);
  assert.equal(game.result, 'Checkmate — Black wins');
  assert.equal(game.moveLog.length, 4);
});

test('legal move hints exclude moves that leave the king in check', () => {
  const game = emptyGame();
  game.board[0][0] = 'bK';
  game.board[0][4] = 'bR';
  game.board[7][4] = 'wK';
  game.board[6][4] = 'wN'; // pinned on the e-file
  game.turn = 'w';

  assert.equal(chess.legalMovesFor(game.board, 6, 4, 'w', game.castling, game.ep).length, 0);
});

test('kingside castling moves the rook and records O-O', () => {
  const game = chess.createGame();
  play(game, [6, 4], [4, 4]); // e4
  play(game, [1, 4], [3, 4]); // e5
  play(game, [7, 6], [5, 5]); // Nf3
  play(game, [0, 1], [2, 2]); // Nc6
  play(game, [7, 5], [4, 2]); // Bc4
  play(game, [0, 6], [2, 5]); // Nf6

  const { san } = play(game, [7, 4], [7, 6]); // O-O

  assert.equal(san, 'O-O');
  assert.equal(game.board[7][6], 'wK');
  assert.equal(game.board[7][5], 'wR');
  assert.equal(game.board[7][7], null);
  assert.equal(game.castling.wK, false);
  assert.equal(game.castling.wQ, false);
});

test('castling is illegal while in check or through an attacked square', () => {
  const game = emptyGame();
  game.board[7][4] = 'wK';
  game.board[7][7] = 'wR';
  game.board[0][4] = 'bK';
  game.board[0][5] = 'bR';
  game.castling = { wK: true, wQ: false, bK: false, bQ: false };

  assert.equal(chess.findLegalMove(game, [7, 4], [7, 6]), null);
});

test('en passant capture removes the passed pawn', () => {
  const game = chess.createGame();
  play(game, [6, 4], [4, 4]); // e4
  play(game, [1, 0], [2, 0]); // a6
  play(game, [4, 4], [3, 4]); // e5
  play(game, [1, 3], [3, 3]); // d5

  const { san } = play(game, [3, 4], [2, 3]); // exd6 e.p.

  assert.equal(san, 'exd6');
  assert.equal(game.board[2][3], 'wP');
  assert.equal(game.board[3][3], null);
});

test('promotion to each piece and SAN suffix', () => {
  for (const type of ['Q', 'R', 'B', 'N']) {
    const game = emptyGame();
    game.board[3][7] = 'bK';
    game.board[7][4] = 'wK';
    game.board[1][0] = 'wP';

    const { san } = play(game, [1, 0], [0, 0], type);

    assert.equal(game.board[0][0], 'w' + type);
    assert.equal(san, 'a8=' + type);
  }
});

test('moving a rook or being captured on its corner removes castling rights', () => {
  const game = emptyGame();
  game.board[0][4] = 'bK';
  game.board[7][4] = 'wK';
  game.board[7][7] = 'wR';
  game.castling = { wK: true, wQ: true, bK: false, bQ: false };

  play(game, [7, 7], [5, 7]); // Rh1-h3

  assert.equal(game.castling.wK, false);
});

function knightPosition() {
  const game = emptyGame();
  game.board[0][4] = 'bK';
  game.board[7][4] = 'wK';
  game.board[7][1] = 'wN';
  game.board[5][5] = 'wN';
  return game;
}

test('SAN disambiguates by file', () => {
  let game = knightPosition();
  assert.equal(play(game, [7, 1], [6, 3]).san, 'Nbd2'); // Nb1-d2

  game = knightPosition();
  assert.equal(play(game, [5, 5], [6, 3]).san, 'Nfd2'); // Nf3-d2
});

test('SAN disambiguates by rank when files match', () => {
  const game = emptyGame();
  game.board[0][4] = 'bK';
  game.board[7][4] = 'wK';
  game.board[7][1] = 'wN';
  game.board[5][1] = 'wN';

  assert.equal(play(game, [7, 1], [6, 3]).san, 'N1d2'); // Nb1-d2
});

test('stalemate is detected as a draw', () => {
  const game = emptyGame();
  game.board[0][0] = 'bK';
  game.board[7][2] = 'wK';
  game.board[3][1] = 'wQ';
  game.turn = 'w';

  const { san } = play(game, [3, 1], [2, 1]); // Qb5-b6

  assert.equal(san, 'Qb6');
  assert.equal(game.over, true);
  assert.equal(game.inCheck, false);
  assert.equal(game.result, 'Stalemate — draw');
});

test('findLegalMove rejects malformed, out-of-turn and illegal moves', () => {
  const game = chess.createGame();
  assert.equal(chess.findLegalMove(game, [1, 4], [3, 4], null), null); // opponent's pawn
  assert.equal(chess.findLegalMove(game, 'e2', 'e4', null), null);
  assert.equal(chess.findLegalMove(game, [6, 4], [4, 3], null), null);
  assert.equal(chess.findLegalMove(game, [6, 4], [6, 4], null), null);
  assert.ok(chess.findLegalMove(game, [6, 4], [4, 4], null));
});
