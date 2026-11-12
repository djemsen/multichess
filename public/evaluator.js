(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChessEvaluator = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function scoreToPercent(type, val) {
    if (type === 'mate') {
      return val > 0 ? 98 : 2;
    }
    // Sigmoid curve mapping centipawns to winning percentage
    var rate = 50 + 50 * (2 / (1 + Math.exp(-0.00368 * val)) - 1);
    return Math.max(3, Math.min(97, Math.round(rate * 10) / 10));
  }

  function formatScore(type, val) {
    if (type === 'mate') {
      return (val > 0 ? '+M' : '-M') + Math.abs(val);
    }
    var pawns = (val / 100).toFixed(1);
    if (val > 0) return '+' + pawns;
    if (val === 0) return '0.0';
    return pawns;
  }

  function parseScore(line, turn) {
    if (typeof line !== 'string') return null;
    var match = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    if (!match) return null;

    var type = match[1];
    var rawVal = parseInt(match[2], 10);

    // UCI engines report score relative to the side whose turn it is.
    // Convert to White-relative score:
    var whiteVal = (turn === 'b') ? -rawVal : rawVal;

    return {
      type: type,
      val: rawVal,
      whiteVal: whiteVal,
      percent: scoreToPercent(type, whiteVal),
      text: formatScore(type, whiteVal)
    };
  }

  function parseBestMove(line) {
    if (typeof line !== 'string') return null;
    var match = line.match(/\bbestmove\s+([a-h][1-8])([a-h][1-8])([qrbnQRBN])?/);
    if (!match) return null;

    var fromStr = match[1];
    var toStr = match[2];
    var promoStr = match[3] ? match[3].toUpperCase() : null;

    var from = [8 - parseInt(fromStr[1], 10), fromStr.charCodeAt(0) - 97];
    var to = [8 - parseInt(toStr[1], 10), toStr.charCodeAt(0) - 97];

    return {
      uci: match[0].split(/\s+/)[1],
      fromStr: fromStr,
      toStr: toStr,
      promo: promoStr,
      from: from,
      to: to
    };
  }

  function createBridge(workerUrl) {
    var worker = null;
    var ready = false;
    var evalCallback = null;
    var moveCallback = null;
    var currentTurn = 'w';

    function init() {
      if (typeof Worker === 'undefined') return false;
      try {
        worker = new Worker(workerUrl || 'lozza.js');
        worker.onmessage = function (e) {
          var line = typeof e.data === 'string' ? e.data : '';
          handleLine(line);
        };
        worker.postMessage('uci');
        worker.postMessage('isready');
        return true;
      } catch (err) {
        worker = null;
        return false;
      }
    }

    function handleLine(line) {
      if (line.indexOf('readyok') !== -1 || line.indexOf('uciok') !== -1) {
        ready = true;
      }

      if (evalCallback && line.indexOf('score') !== -1) {
        var parsed = parseScore(line, currentTurn);
        if (parsed) evalCallback(parsed);
      }

      if (line.indexOf('bestmove') !== -1) {
        var best = parseBestMove(line);
        if (moveCallback) {
          var cb = moveCallback;
          moveCallback = null;
          cb(best);
        }
      }
    }

    function evaluate(fen, turn, onScore) {
      if (!worker) return false;
      currentTurn = turn || 'w';
      evalCallback = onScore || null;
      worker.postMessage('stop');
      worker.postMessage('position fen ' + fen);
      worker.postMessage('go depth 8');
      return true;
    }

    function findMove(fen, depth, onBestMove) {
      if (!worker) return false;
      moveCallback = onBestMove || null;
      worker.postMessage('stop');
      worker.postMessage('position fen ' + fen);
      worker.postMessage('go depth ' + (depth || 6));
      return true;
    }

    function stop() {
      if (!worker) return;
      evalCallback = null;
      moveCallback = null;
      worker.postMessage('stop');
    }

    function terminate() {
      if (!worker) return;
      worker.terminate();
      worker = null;
      ready = false;
    }

    return {
      init: init,
      evaluate: evaluate,
      findMove: findMove,
      stop: stop,
      terminate: terminate,
      isAvailable: function () { return Boolean(worker); }
    };
  }

  return {
    scoreToPercent: scoreToPercent,
    formatScore: formatScore,
    parseScore: parseScore,
    parseBestMove: parseBestMove,
    createBridge: createBridge
  };
});
