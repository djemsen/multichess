/* Shared chess rules for MultiChess. Runs in the browser (window.ChessEngine)
   and in Node (module.exports), so the server enforces exactly the rules the
   client uses for move hints. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChessEngine = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var FILES = 'abcdefgh';

  var KNIGHT_STEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  var DIAGONAL = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var ORTHOGONAL = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var ALL_DIRECTIONS = DIAGONAL.concat(ORTHOGONAL);

  function startBoard() {
    return [
      ['bR', 'bN', 'bB', 'bQ', 'bK', 'bB', 'bN', 'bR'],
      ['bP', 'bP', 'bP', 'bP', 'bP', 'bP', 'bP', 'bP'],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ['wP', 'wP', 'wP', 'wP', 'wP', 'wP', 'wP', 'wP'],
      ['wR', 'wN', 'wB', 'wQ', 'wK', 'wB', 'wN', 'wR']
    ];
  }

  function createGame() {
    return {
      board: startBoard(),
      turn: 'w',
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      ep: null,
      fullmove: 1,
      moveLog: [],
      lastMove: null,
      inCheck: false,
      over: false,
      result: ''
    };
  }

  function cloneBoard(board) {
    return board.map(function (row) { return row.slice(); });
  }

  function inside(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  function other(color) {
    return color === 'w' ? 'b' : 'w';
  }

  function colorName(color) {
    return color === 'w' ? 'White' : 'Black';
  }

  function sqName(r, c) {
    return FILES[c] + (8 - r);
  }

  function findKing(board, color) {
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        if (board[r][c] === color + 'K') return [r, c];
      }
    }
    return null;
  }

  function isAttacked(board, r, c, by) {
    var pawnRow = r + (by === 'w' ? 1 : -1);
    for (var i = 0; i < 2; i++) {
      var pc = c + (i === 0 ? -1 : 1);
      if (inside(pawnRow, pc) && board[pawnRow][pc] === by + 'P') return true;
    }

    for (var n = 0; n < KNIGHT_STEPS.length; n++) {
      var nr = r + KNIGHT_STEPS[n][0];
      var nc = c + KNIGHT_STEPS[n][1];
      if (inside(nr, nc) && board[nr][nc] === by + 'N') return true;
    }

    for (var k = 0; k < ALL_DIRECTIONS.length; k++) {
      var kr = r + ALL_DIRECTIONS[k][0];
      var kc = c + ALL_DIRECTIONS[k][1];
      if (inside(kr, kc) && board[kr][kc] === by + 'K') return true;
    }

    var sliders = [
      { dirs: DIAGONAL, types: ['B', 'Q'] },
      { dirs: ORTHOGONAL, types: ['R', 'Q'] }
    ];

    for (var s = 0; s < sliders.length; s++) {
      var dirs = sliders[s].dirs;
      var types = sliders[s].types;
      for (var d = 0; d < dirs.length; d++) {
        var tr = r + dirs[d][0];
        var tc = c + dirs[d][1];
        while (inside(tr, tc)) {
          var piece = board[tr][tc];
          if (piece) {
            if (piece[0] === by && types.indexOf(piece[1]) !== -1) return true;
            break;
          }
          tr += dirs[d][0];
          tc += dirs[d][1];
        }
      }
    }

    return false;
  }

  function isInCheck(board, color) {
    var king = findKing(board, color);
    return Boolean(king) && isAttacked(board, king[0], king[1], other(color));
  }

  function genMoves(board, r, c, turn, castling, ep) {
    var piece = board[r][c];
    if (!piece || piece[0] !== turn) return [];

    var color = piece[0];
    var type = piece[1];
    var moves = [];

    function push(tr, tc, extra) {
      var move = { from: [r, c], to: [tr, tc] };
      if (extra) {
        for (var key in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, key)) move[key] = extra[key];
        }
      }
      moves.push(move);
    }

    function canLand(tr, tc) {
      return !board[tr][tc] || board[tr][tc][0] !== color;
    }

    if (type === 'P') {
      var dir = color === 'w' ? -1 : 1;
      var startRow = color === 'w' ? 6 : 1;
      var promoRow = color === 'w' ? 0 : 7;
      var one = r + dir;

      if (inside(one, c) && !board[one][c]) {
        if (one === promoRow) {
          for (var q = 0; q < 4; q++) push(one, c, { promo: 'QRBN'[q] });
        } else {
          push(one, c);
          var two = r + dir * 2;
          if (r === startRow && !board[two][c]) push(two, c);
        }
      }

      for (var p = 0; p < 2; p++) {
        var dc = p === 0 ? -1 : 1;
        var tr = r + dir;
        var tc = c + dc;
        if (!inside(tr, tc)) continue;
        var target = board[tr][tc];

        if (target && target[0] !== color) {
          if (tr === promoRow) {
            for (var q2 = 0; q2 < 4; q2++) push(tr, tc, { promo: 'QRBN'[q2], capture: true });
          } else {
            push(tr, tc, { capture: true });
          }
        } else if (!target && ep && ep[0] === tr && ep[1] === tc) {
          push(tr, tc, { ep: true, capture: true });
        }
      }
    } else if (type === 'N' || type === 'K') {
      var steps = type === 'N' ? KNIGHT_STEPS : ALL_DIRECTIONS;
      for (var st = 0; st < steps.length; st++) {
        var nr = r + steps[st][0];
        var nc = c + steps[st][1];
        if (inside(nr, nc) && canLand(nr, nc)) {
          push(nr, nc, board[nr][nc] ? { capture: true } : null);
        }
      }

      if (type === 'K') {
        var home = color === 'w' ? 7 : 0;
        var enemy = other(color);
        if (r === home && c === 4 && !isAttacked(board, home, 4, enemy)) {
          if (
            castling[color + 'K'] &&
            board[home][7] === color + 'R' &&
            !board[home][5] && !board[home][6] &&
            !isAttacked(board, home, 5, enemy) &&
            !isAttacked(board, home, 6, enemy)
          ) {
            push(home, 6, { castle: 'K' });
          }
          if (
            castling[color + 'Q'] &&
            board[home][0] === color + 'R' &&
            !board[home][1] && !board[home][2] && !board[home][3] &&
            !isAttacked(board, home, 3, enemy) &&
            !isAttacked(board, home, 2, enemy)
          ) {
            push(home, 2, { castle: 'Q' });
          }
        }
      }
    } else {
      var slideDirs = type === 'B' ? DIAGONAL : type === 'R' ? ORTHOGONAL : ALL_DIRECTIONS;
      for (var sd = 0; sd < slideDirs.length; sd++) {
        var sr = r + slideDirs[sd][0];
        var sc = c + slideDirs[sd][1];
        while (inside(sr, sc)) {
          var square = board[sr][sc];
          if (!square) {
            push(sr, sc);
          } else {
            if (square[0] !== color) push(sr, sc, { capture: true });
            break;
          }
          sr += slideDirs[sd][0];
          sc += slideDirs[sd][1];
        }
      }
    }

    return moves;
  }

  function applyToBoard(board, move, color) {
    var fr = move.from[0];
    var fc = move.from[1];
    var tr = move.to[0];
    var tc = move.to[1];
    var piece = board[fr][fc];

    if (move.ep) board[fr][tc] = null;

    if (move.castle === 'K') {
      board[fr][5] = board[fr][7];
      board[fr][7] = null;
    } else if (move.castle === 'Q') {
      board[fr][3] = board[fr][0];
      board[fr][0] = null;
    }

    board[tr][tc] = move.promo ? color + move.promo : piece;
    board[fr][fc] = null;
  }

  function legalMovesFor(board, r, c, turn, castling, ep) {
    var moves = genMoves(board, r, c, turn, castling, ep);
    return moves.filter(function (move) {
      var next = cloneBoard(board);
      applyToBoard(next, move, turn);
      var king = findKing(next, turn);
      return king && !isAttacked(next, king[0], king[1], other(turn));
    });
  }

  function allLegalMoves(board, turn, castling, ep) {
    var moves = [];
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        if (board[r][c] && board[r][c][0] === turn) {
          moves = moves.concat(legalMovesFor(board, r, c, turn, castling, ep));
        }
      }
    }
    return moves;
  }

  function toSAN(game, move) {
    var board = game.board;
    var fr = move.from[0];
    var fc = move.from[1];
    var tr = move.to[0];
    var tc = move.to[1];
    var piece = board[fr][fc];
    var color = piece[0];
    var type = piece[1];

    if (move.castle === 'K') return 'O-O';
    if (move.castle === 'Q') return 'O-O-O';

    var isCapture = Boolean(board[tr][tc]) || Boolean(move.ep);

    if (type === 'P') {
      var pawnSan = '';
      if (isCapture) pawnSan += FILES[fc] + 'x';
      pawnSan += sqName(tr, tc);
      if (move.promo) pawnSan += '=' + move.promo;
      return pawnSan;
    }

    var san = type;
    var rivals = [];

    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        if ((r === fr && c === fc) || board[r][c] !== color + type) continue;
        var options = legalMovesFor(board, r, c, color, game.castling, game.ep);
        for (var i = 0; i < options.length; i++) {
          if (options[i].to[0] === tr && options[i].to[1] === tc) {
            rivals.push([r, c]);
            break;
          }
        }
      }
    }

    if (rivals.length) {
      var sameFile = rivals.some(function (sq) { return sq[1] === fc; });
      var sameRank = rivals.some(function (sq) { return sq[0] === fr; });
      if (!sameFile) san += FILES[fc];
      else if (!sameRank) san += String(8 - fr);
      else san += sqName(fr, fc);
    }

    if (isCapture) san += 'x';
    san += sqName(tr, tc);
    return san;
  }

  function toFEN(game) {
    if (!game || !Array.isArray(game.board)) return '';
    var rows = [];
    for (var r = 0; r < 8; r++) {
      var empty = 0;
      var rowStr = '';
      for (var c = 0; c < 8; c++) {
        var piece = game.board[r][c];
        if (!piece) {
          empty++;
        } else {
          if (empty > 0) {
            rowStr += empty;
            empty = 0;
          }
          var type = piece[1];
          rowStr += piece[0] === 'w' ? type.toUpperCase() : type.toLowerCase();
        }
      }
      if (empty > 0) rowStr += empty;
      rows.push(rowStr);
    }

    var castling = game.castling || {};
    var castlingStr = '';
    if (castling.wK) castlingStr += 'K';
    if (castling.wQ) castlingStr += 'Q';
    if (castling.bK) castlingStr += 'k';
    if (castling.bQ) castlingStr += 'q';
    if (!castlingStr) castlingStr = '-';

    var epStr = game.ep ? sqName(game.ep[0], game.ep[1]) : '-';
    var fullmove = game.fullmove || 1;

    return rows.join('/') + ' ' + (game.turn || 'w') + ' ' + castlingStr + ' ' + epStr + ' 0 ' + fullmove;
  }

  function makeMove(game, move) {
    var color = game.turn;
    var board = game.board;
    var fr = move.from[0];
    var fc = move.from[1];
    var tr = move.to[0];
    var tc = move.to[1];
    var piece = board[fr][fc];
    var type = piece[1];
    var san = toSAN(game, move);

    applyToBoard(board, move, color);

    if (type === 'K') {
      game.castling[color + 'K'] = false;
      game.castling[color + 'Q'] = false;
    }
    if (type === 'R') {
      if (fr === 7 && fc === 0) game.castling.wQ = false;
      if (fr === 7 && fc === 7) game.castling.wK = false;
      if (fr === 0 && fc === 0) game.castling.bQ = false;
      if (fr === 0 && fc === 7) game.castling.bK = false;
    }
    if (tr === 7 && tc === 0) game.castling.wQ = false;
    if (tr === 7 && tc === 7) game.castling.wK = false;
    if (tr === 0 && tc === 0) game.castling.bQ = false;
    if (tr === 0 && tc === 7) game.castling.bK = false;

    game.ep = type === 'P' && Math.abs(tr - fr) === 2 ? [(fr + tr) / 2, fc] : null;
    game.lastMove = { from: [fr, fc], to: [tr, tc] };
    if (color === 'b') game.fullmove++;
    game.turn = other(color);

    game.inCheck = isInCheck(game.board, game.turn);
    var replies = allLegalMoves(game.board, game.turn, game.castling, game.ep);
    game.over = replies.length === 0;
    game.result = game.over
      ? (game.inCheck
        ? 'Checkmate — ' + colorName(other(game.turn)) + ' wins'
        : 'Stalemate — draw')
      : '';

    if (game.over) san += game.inCheck ? '#' : '';
    else if (game.inCheck) san += '+';

    game.moveLog.push({ san: san, color: color });
    return san;
  }

  function findLegalMove(game, from, to, promo) {
    if (!Array.isArray(from) || !Array.isArray(to) || from.length !== 2 || to.length !== 2) return null;
    if (!Number.isInteger(from[0]) || !Number.isInteger(from[1]) ||
        !Number.isInteger(to[0]) || !Number.isInteger(to[1])) return null;

    var moves = allLegalMoves(game.board, game.turn, game.castling, game.ep);
    for (var i = 0; i < moves.length; i++) {
      var move = moves[i];
      if (move.from[0] !== from[0] || move.from[1] !== from[1]) continue;
      if (move.to[0] !== to[0] || move.to[1] !== to[1]) continue;
      if (move.promo) {
        if (promo === move.promo) return move;
      } else if (!promo) {
        return move;
      }
    }
    return null;
  }

  return {
    FILES: FILES,
    startBoard: startBoard,
    createGame: createGame,
    cloneBoard: cloneBoard,
    inside: inside,
    other: other,
    colorName: colorName,
    sqName: sqName,
    findKing: findKing,
    isAttacked: isAttacked,
    isInCheck: isInCheck,
    genMoves: genMoves,
    applyToBoard: applyToBoard,
    legalMovesFor: legalMovesFor,
    allLegalMoves: allLegalMoves,
    toSAN: toSAN,
    toFEN: toFEN,
    makeMove: makeMove,
    findLegalMove: findLegalMove
  };
});
