(function () {
  'use strict';

  var ENG = window.ChessEngine;
  var CLOCK = window.ChessClock;
  var GLYPHS = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
  var SESSION_KEY = 'multichess.session';
  var NAME_KEY = 'multichess.name';
  var DIFFICULTY_KEY = 'multichess.difficulty';
  var DIFFICULTIES = {
    easy: { label: 'Easy', depth: 0, random: true },
    medium: { label: 'Medium', depth: 1, random: false },
    hard: { label: 'Hard', depth: 2, random: false }
  };

  function $(id) {
    return document.getElementById(id);
  }

  var app = {
    room: null,
    token: null,
    color: null,
    name: null,
    difficulty: 'medium',
    pendingMode: null,
    timeControl: 'normal',
    state: null,
    selected: null,
    legal: [],
    flipped: false,
    manualFlip: false,
    busy: false,
    promoMoves: null,
    chatBusy: false,
    chatCount: 0,
    chatSignature: null,
    es: null,
    connection: 'offline',
    reconnectTimer: null,
    toastTimer: null,
    animKey: null
  };

  // -------------------------------------------------------------------------
  // Sound (generated in the browser; no audio files)
  // -------------------------------------------------------------------------

  var sound = (function () {
    var EFFECTS_KEY = 'multichess.muted';
    var MUSIC_KEY = 'multichess.music';
    var MUSIC_VOLUME_KEY = 'multichess.musicVolume';
    var audio = null;
    var effectsMuted = false;
    var musicOn = true;
    var musicVolume = 1;

    try {
      effectsMuted = localStorage.getItem(EFFECTS_KEY) === '1';
      if (localStorage.getItem(MUSIC_KEY) === '0') musicOn = false;
      var storedVolume = localStorage.getItem(MUSIC_VOLUME_KEY);
      if (storedVolume !== null) {
        var volume = Number(storedVolume);
        if (isFinite(volume)) musicVolume = Math.max(0, Math.min(1, volume));
      }
    } catch (err) {
      effectsMuted = false;
      musicOn = true;
      musicVolume = 1;
    }

    function context() {
      if (!audio) {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        try {
          audio = new AudioCtx();
        } catch (err) {
          return null;
        }
      }

      if (audio.state === 'suspended') {
        try {
          audio.resume();
        } catch (err) {
          // The next user gesture will retry.
        }
      }

      return audio;
    }

    function tone(freq, when, duration, peak, type, destination) {
      var osc = audio.createOscillator();
      var gain = audio.createGain();

      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, when);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

      osc.connect(gain);
      gain.connect(destination || audio.destination);
      osc.start(when);
      osc.stop(when + duration + 0.03);
    }

    function tock(when, freq, peak) {
      var osc = audio.createOscillator();
      var gain = audio.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, when);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.55, when + 0.07);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);

      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(when);
      osc.stop(when + 0.13);
    }

    function play(kind) {
      try {
        if (effectsMuted) return;
        if (!context()) return;

        var now = audio.currentTime + 0.01;

        if (kind === 'capture') {
          tock(now, 300, 0.16);
          tock(now + 0.045, 190, 0.1);
        } else if (kind === 'check') {
          tone(720, now, 0.09, 0.09, 'sine');
          tone(980, now + 0.09, 0.12, 0.07, 'sine');
        } else if (kind === 'end') {
          tone(520, now, 0.16, 0.08, 'sine');
          tone(390, now + 0.12, 0.18, 0.07, 'sine');
          tone(260, now + 0.25, 0.3, 0.06, 'sine');
        } else {
          tock(now, 430, 0.14);
        }
      } catch (err) {
        // Sound is optional; never let audio break the game.
      }
    }

    function playForSan(san) {
      if (!san) return;
      if (san.indexOf('#') !== -1) play('end');
      else if (san.indexOf('+') !== -1) play('check');
      else if (san.indexOf('x') !== -1) play('capture');
      else play('move');
    }

    function playChat(ownMessage) {
      try {
        if (effectsMuted) return;
        if (!context()) return;

        var now = audio.currentTime + 0.01;

        if (ownMessage) {
          tone(880, now, 0.07, 0.045, 'sine');
        } else {
          tone(620, now, 0.08, 0.04, 'sine');
          tone(880, now + 0.07, 0.1, 0.032, 'sine');
        }
      } catch (err) {
        // Sound is optional; never let audio break chat.
      }
    }

    // -----------------------------------------------------------------------
    // Background music: a slow, ambient loop generated with Web Audio.
    // -----------------------------------------------------------------------

    var MUSIC_STEP = 0.72;
    var MUSIC_PROGRESSION = [
      { bass: 110.00, notes: [220.00, 261.63, 329.63] }, // A minor
      { bass: 87.31, notes: [174.61, 220.00, 261.63] },  // F major
      { bass: 130.81, notes: [261.63, 329.63, 392.00] }, // C major
      { bass: 98.00, notes: [196.00, 246.94, 293.66] }   // G major
    ];
    var MUSIC_PATTERNS = [
      [0, 1, 2, 1],
      [0, 2, 1, 2],
      [1, 2, 0, 1],
      [2, 1, 0, 1]
    ];

    var musicBus = null;
    var musicTimer = null;
    var musicPlaying = false;
    var musicStep = 0;
    var nextMusicNote = 0;

    function musicTone(freq, when, duration, peak, type) {
      if (!musicBus) return;
      tone(freq, when, duration, peak, type, musicBus);
    }

    function scheduleMusic() {
      if (!musicPlaying || !audio) return;

      var horizon = audio.currentTime + 0.8;

      while (nextMusicNote < horizon) {
        var bar = Math.floor(musicStep / 4) % MUSIC_PROGRESSION.length;
        var chord = MUSIC_PROGRESSION[bar];
        var pattern = MUSIC_PATTERNS[bar];
        var note = chord.notes[pattern[musicStep % pattern.length]];

        if (musicStep % 4 === 0) {
          musicTone(chord.bass, nextMusicNote, 2.8, 0.032, 'sine');
        }

        musicTone(note, nextMusicNote, 1.45, 0.022, 'triangle');

        if (musicStep % 8 === 5) {
          musicTone(note * 2, nextMusicNote, 0.9, 0.009, 'sine');
        }

        nextMusicNote += MUSIC_STEP;
        musicStep++;
      }
    }

    function holdGain(param, now) {
      if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(now);
        return;
      }

      if (typeof param.cancelScheduledValues === 'function') {
        param.cancelScheduledValues(now);
      }

      var current = typeof param.value === 'number' && isFinite(param.value)
        ? param.value
        : 0.0001;
      param.setValueAtTime(Math.max(0.0001, current), now);
    }

    function startMusic() {
      if (musicPlaying || !musicOn) return;
      if (!context()) return;

      if (!musicBus) {
        musicBus = audio.createGain();
        musicBus.gain.setValueAtTime(0.0001, audio.currentTime);
        musicBus.connect(audio.destination);
      }

      var now = audio.currentTime;
      musicPlaying = true;
      musicStep = 0;
      nextMusicNote = now + 0.2;

      holdGain(musicBus.gain, now);
      musicBus.gain.exponentialRampToValueAtTime(Math.max(musicVolume, 0.0001), now + 1.2);

      scheduleMusic();
      musicTimer = setInterval(scheduleMusic, 250);
    }

    function stopMusic() {
      if (musicTimer) {
        clearInterval(musicTimer);
        musicTimer = null;
      }
      if (!musicPlaying) return;

      musicPlaying = false;

      if (musicBus && audio) {
        var now = audio.currentTime;
        holdGain(musicBus.gain, now);
        musicBus.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
      }
    }

    function setMusicVolume(value) {
      musicVolume = Math.max(0, Math.min(1, value));
      try {
        localStorage.setItem(MUSIC_VOLUME_KEY, String(musicVolume));
      } catch (err) {
        // ignore storage failures
      }
      if (musicPlaying && musicBus && audio) {
        var now = audio.currentTime;
        holdGain(musicBus.gain, now);
        musicBus.gain.exponentialRampToValueAtTime(Math.max(musicVolume, 0.0001), now + 0.3);
      }
    }

    function getMusicVolume() {
      return musicVolume;
    }

    function setMusicActive(active) {
      if (active && musicOn) startMusic();
      else stopMusic();
    }

    // -----------------------------------------------------------------------
    // Buttons and preferences
    // -----------------------------------------------------------------------

    function updateSoundButton() {
      var button = $('soundBtn');
      if (!button) return;
      var label = effectsMuted ? 'Unmute game sounds' : 'Mute game sounds';
      button.classList.toggle('muted', effectsMuted);
      button.setAttribute('aria-pressed', String(!effectsMuted));
      button.setAttribute('aria-label', label);
      button.title = label;
    }

    function updateMusicButton() {
      var button = $('musicBtn');
      if (!button) return;
      var label = musicOn ? 'Mute music' : 'Unmute music';
      button.classList.toggle('muted', !musicOn);
      button.setAttribute('aria-pressed', String(musicOn));
      button.setAttribute('aria-label', label);
      button.title = label;
    }

    function updateButtons() {
      updateSoundButton();
      updateMusicButton();
    }

    function setEffectsMuted(value) {
      effectsMuted = Boolean(value);
      try {
        localStorage.setItem(EFFECTS_KEY, effectsMuted ? '1' : '0');
      } catch (err) {
        // ignore storage failures
      }
      updateSoundButton();
    }

    function toggle() {
      setEffectsMuted(!effectsMuted);
      if (!effectsMuted) play('move');
    }

    function toggleMusic() {
      musicOn = !musicOn;
      try {
        localStorage.setItem(MUSIC_KEY, musicOn ? '1' : '0');
      } catch (err) {
        // ignore storage failures
      }
      updateMusicButton();
    }

    function unlock() {
      context();
    }

    function resume() {
      context();
    }

    return {
      playForSan: playForSan,
      playChat: playChat,
      toggle: toggle,
      toggleMusic: toggleMusic,
      setMusicActive: setMusicActive,
      setMusicVolume: setMusicVolume,
      getMusicVolume: getMusicVolume,
      resume: resume,
      unlock: unlock,
      updateButtons: updateButtons
    };
  })();

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  function api(path, body) {
    var options = { cache: 'no-store' };
    if (body !== undefined) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }

    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) {
        if (!response.ok || !data || data.ok === false) {
          var message = (data && data.error) || ('Request failed (' + response.status + ')');
          var error = new Error(message);
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  function readStoredSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.room === 'string' && typeof parsed.token === 'string') return parsed;
    } catch (err) {
      // ignore
    }
    return null;
  }

  function saveSession(session) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ room: session.room, token: session.token }));
    } catch (err) {
      // ignore
    }
  }

  function clearStoredSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (err) {
      // ignore
    }
  }

  function readStoredName() {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch (err) {
      return '';
    }
  }

  function saveName(name) {
    try {
      localStorage.setItem(NAME_KEY, name || '');
    } catch (err) {
      // ignore
    }
  }

  function readStoredDifficulty() {
    try {
      var value = localStorage.getItem(DIFFICULTY_KEY);
      if (value && Object.prototype.hasOwnProperty.call(DIFFICULTIES, value)) return value;
    } catch (err) {
      // ignore
    }
    return 'medium';
  }

  function saveDifficulty(value) {
    try {
      localStorage.setItem(DIFFICULTY_KEY, value);
    } catch (err) {
      // ignore
    }
  }

  function other(color) {
    return color === 'w' ? 'b' : 'w';
  }

  function colorName(color) {
    return color === 'w' ? 'White' : 'Black';
  }

  function setText(el, text) {
    el.textContent = text;
  }

  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(app.toastTimer);
    app.toastTimer = setTimeout(function () {
      el.classList.add('hidden');
    }, 3600);
  }

  function setConnection(online) {
    app.connection = online ? 'online' : 'offline';
    var dot = $('connDot');
    dot.classList.toggle('online', online);
    dot.classList.toggle('offline', !online);
  }

  function cleanUrl(room) {
    try {
      var url = room ? (location.pathname + '?room=' + encodeURIComponent(room)) : location.pathname;
      history.replaceState(null, '', url);
    } catch (err) {
      // ignore
    }
  }

  function inviteLink() {
    return location.origin + '/?room=' + encodeURIComponent(app.room || '');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () {
        toast('Invite link copied.');
      }).catch(function () {
        fallbackCopy(text);
      });
      return;
    }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    if (ok) toast('Invite link copied.');
    else window.prompt('Copy this invite link:', text);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  function startSession(session, state) {
    app.room = session.room;
    app.token = session.token;
    app.color = session.color;
    app.name = session.name;
    app.state = null;
    app.selected = null;
    app.legal = [];
    app.busy = false;
    app.promoMoves = null;
    app.manualFlip = false;
    app.chatBusy = false;
    app.chatCount = 0;
    app.chatSignature = null;

    saveSession(session);
    saveName(session.name);

    $('modeScreen').classList.add('hidden');
    $('timingScreen').classList.add('hidden');
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('roomBadge').classList.remove('hidden');
    $('lobbyError').textContent = '';
    setText($('roomBadgeCode'), session.room);
    setText($('waitingCode'), session.room);

    applyState(state);
    connectEvents();
    cleanUrl(session.room);
  }

  function showLobby(message) {
    closeEvents();
    app.room = null;
    app.token = null;
    app.color = null;
    app.state = null;
    app.selected = null;
    app.legal = [];
    app.busy = false;
    app.promoMoves = null;
    app.manualFlip = false;
    app.chatBusy = false;
    app.chatCount = 0;
    app.chatSignature = null;

    $('game').classList.add('hidden');
    $('modeScreen').classList.add('hidden');
    $('timingScreen').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    $('roomBadge').classList.add('hidden');
    $('lobbyError').textContent = message || '';
    setText($('lobbyTimeControl'), app.timeControl === 'blitz'
      ? 'Blitz · 10 minutes per player'
      : 'Normal · No clock');
    setConnection(false);
    syncMusic();
  }

  function showModeScreen() {
    closeEvents();
    app.room = null;
    app.token = null;
    app.color = null;
    app.state = null;
    app.selected = null;
    app.legal = [];
    app.busy = false;
    app.promoMoves = null;
    app.manualFlip = false;
    app.chatBusy = false;
    app.chatCount = 0;
    app.chatSignature = null;

    $('game').classList.add('hidden');
    $('modeScreen').classList.remove('hidden');
    $('timingScreen').classList.add('hidden');
    $('lobby').classList.add('hidden');
    $('roomBadge').classList.add('hidden');
    $('lobbyError').textContent = '';
    app.pendingMode = null;
    setConnection(false);
    syncMusic();
  }

  function showTimingScreen(mode) {
    showModeScreen();
    app.pendingMode = mode;
    setText($('timingTitle'), mode === 'single' ? 'Single player' : 'Multiplayer');
    setText($('timingSub'), mode === 'single'
      ? 'Play White against the computer. Choose a time control.'
      : 'Create or join a room. Choose the time control for a new room.');
    $('modeScreen').classList.add('hidden');
    $('timingScreen').classList.remove('hidden');
  }

  function chooseTimeControl(mode) {
    app.timeControl = mode === 'blitz' ? 'blitz' : 'normal';
    if (app.pendingMode === 'single') {
      startSinglePlayer();
    } else if (app.pendingMode === 'multi') {
      app.pendingMode = null;
      showLobby();
    } else {
      showModeScreen();
    }
  }

  function startSinglePlayer() {
    var name = $('nameInput').value;
    var game = ENG.createGame();
    var difficulty = $('difficultySelect').value;
    var blitz = app.timeControl === 'blitz';

    if (!Object.prototype.hasOwnProperty.call(DIFFICULTIES, difficulty)) {
      difficulty = app.difficulty;
    }
    app.difficulty = difficulty;
    saveDifficulty(difficulty);

    app.room = null;
    app.token = null;
    app.color = 'w';
    app.name = name;
    app.state = {
      room: null,
      status: 'playing',
      timeControl: blitz ? 'blitz' : 'normal',
      clock: blitz ? CLOCK.create() : null,
      seats: {
        w: { name: name, connected: true },
        b: { name: 'Computer (' + DIFFICULTIES[difficulty].label + ')', connected: true }
      },
      game: game,
      offers: { draw: null, rematch: [] },
      chat: []
    };
    if (app.state.clock) CLOCK.start(app.state.clock, 'w');

    app.selected = null;
    app.legal = [];
    app.busy = false;
    app.promoMoves = null;
    app.manualFlip = false;
    app.chatBusy = false;
    app.chatCount = 0;
    app.chatSignature = null;

    $('modeScreen').classList.add('hidden');
    $('timingScreen').classList.add('hidden');
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('roomBadge').classList.add('hidden');
    $('lobbyError').textContent = '';
    setText($('roomBadgeCode'), 'CPU');
    setText($('waitingCode'), 'CPU');

    applyState(app.state);
    syncMusic();
  }

  function startMultiplayer() {
    showTimingScreen('multi');
  }

  function clockExpired() {
    var state = app.state;
    if (!state || !state.clock || !state.clock.active) return false;
    return CLOCK.remaining(state.clock, state.clock.active) <= 0;
  }

  function commitLocalClock() {
    var state = app.state;
    if (!state || !state.clock) return null;
    return CLOCK.commit(state.clock);
  }

  function startLocalClock(color) {
    if (app.state && app.state.clock) CLOCK.start(app.state.clock, color);
  }

  function finishLocalTimeout(loser) {
    var state = app.state;
    if (!state || !state.clock || !state.game) return;

    state.clock[loser] = 0;
    state.clock.active = null;
    state.clock.since = null;
    state.game.over = true;
    state.status = 'over';

    var winner = loser === 'w' ? 'b' : 'w';
    state.game.result = colorName(winner) + ' wins — ' +
      colorName(loser) + ' ran out of time';
    state.offers.draw = null;

    render();
    syncMusic();
  }

  function cloneLocalGame(game) {
    var copy = ENG.createGame();
    copy.board = ENG.cloneBoard(game.board);
    copy.turn = game.turn;
    copy.castling = {
      wK: Boolean(game.castling.wK),
      wQ: Boolean(game.castling.wQ),
      bK: Boolean(game.castling.bK),
      bQ: Boolean(game.castling.bQ)
    };
    copy.ep = game.ep;
    copy.fullmove = game.fullmove;
    copy.moveLog = game.moveLog ? game.moveLog.slice() : [];
    copy.lastMove = game.lastMove;
    copy.inCheck = game.inCheck;
    copy.over = game.over;
    copy.result = game.result;
    return copy;
  }

  function evaluateBoard(board) {
    var values = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
    var score = 0;
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var square = board[r][c];
        if (!square) continue;
        var value = values[square[1]] || 0;
        score += square[0] === 'w' ? value : -value;
      }
    }
    return score;
  }

  function orderedMoves(game) {
    var moves = ENG.allLegalMoves(game.board, game.turn, game.castling, game.ep);
    moves.sort(function (a, b) {
      var aScore = (a.capture ? 10 : 0) + (a.promo ? 5 : 0);
      var bScore = (b.capture ? 10 : 0) + (b.promo ? 5 : 0);
      return bScore - aScore;
    });
    return moves;
  }

  function searchGame(game, depth, alpha, beta) {
    if (game.over) return game.inCheck ? -10000 - (30 - depth) : 0;
    if (depth <= 0) return evaluateBoard(game.board) * (game.turn === 'w' ? 1 : -1);

    var moves = orderedMoves(game);
    if (!moves.length) return -10000 - (30 - depth);

    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var sim = cloneLocalGame(game);
      ENG.makeMove(sim, moves[i]);
      var score = -searchGame(sim, depth - 1, -beta, -alpha);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function chooseAIMove(game, difficulty) {
    var level = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;
    var moves = orderedMoves(game);
    if (!moves.length) return null;

    if (level.random) {
      return moves[Math.floor(Math.random() * moves.length)];
    }

    var bestMove = null;
    var bestScore = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var sim = cloneLocalGame(game);
      ENG.makeMove(sim, moves[i]);
      var score = -searchGame(sim, level.depth, -Infinity, Infinity);
      if (score > bestScore) {
        bestScore = score;
        bestMove = moves[i];
      }
    }
    return bestMove;
  }

  function aiPlay() {
    var state = app.state;
    var game = state && state.game;
    if (!game || game.over || state.status !== 'playing') return;
    if (game.turn !== 'b') return;
    if (clockExpired()) {
      finishLocalTimeout(state.clock.active);
      return;
    }

    var move = chooseAIMove(game, app.difficulty);
    if (!move) return;

    app.busy = true;
    render();

    var spent = commitLocalClock();
    if (spent && spent.remaining <= 0) {
      app.busy = false;
      finishLocalTimeout(spent.color);
      return;
    }

    var san = ENG.makeMove(game, move);
    sound.playForSan(san);
    if (!game.over) startLocalClock(game.turn);

    app.busy = false;
    render();
  }

  function localMove(move) {
    if (!app.state || app.state.status !== 'playing') return;
    if (app.state.game.over) return;
    if (clockExpired()) {
      finishLocalTimeout(app.state.clock.active);
      return;
    }

    app.busy = true;
    clearSelection(false);
    render();

    var spent = commitLocalClock();
    if (spent && spent.remaining <= 0) {
      app.busy = false;
      finishLocalTimeout(spent.color);
      return;
    }

    var san = ENG.makeMove(app.state.game, move);
    sound.playForSan(san);
    if (!app.state.game.over) startLocalClock(app.state.game.turn);

    app.busy = false;
    render();

    var game = app.state.game;
    if (!game.over && game.turn !== app.color) {
      window.setTimeout(aiPlay, 450);
    }
  }

  function sessionLost(message) {
    clearStoredSession();
    closeEvents();
    showLobby(message || 'That game is no longer available.');
    cleanUrl(null);
  }

  function resumeSession(session) {
    api('/api/session?room=' + encodeURIComponent(session.room) +
      '&token=' + encodeURIComponent(session.token))
      .then(function (data) {
        startSession({
          room: data.room,
          token: session.token,
          color: data.color,
          name: data.name
        }, data.state);
      })
      .catch(function (err) {
        if (err.status === 403 || err.status === 404) {
          clearStoredSession();
          showLobby('That game is no longer available.');
          cleanUrl(null);
        } else {
          showLobby('Could not reach the game server. Is it running?');
          cleanUrl(null);
        }
      });
  }

  function createGame() {
    var name = $('nameInput').value;
    $('lobbyError').textContent = '';
    setLobbyBusy(true);

    api('/api/create', { name: name, timeControl: app.timeControl })
      .then(function (data) {
        saveName(name);
        startSession({
          room: data.room,
          token: data.token,
          color: data.color,
          name: data.name
        }, data.state);
      })
      .catch(function (err) {
        $('lobbyError').textContent = err.message;
      })
      .then(function () {
        setLobbyBusy(false);
      });
  }

  function joinGame() {
    var code = $('codeInput').value.trim().toUpperCase();
    $('lobbyError').textContent = '';

    if (code.length !== 5) {
      $('lobbyError').textContent = 'Enter the 5-character room code.';
      return;
    }

    setLobbyBusy(true);
    api('/api/join', { room: code, name: $('nameInput').value })
      .then(function (data) {
        saveName($('nameInput').value);
        startSession({
          room: data.room,
          token: data.token,
          color: data.color,
          name: data.name
        }, data.state);
      })
      .catch(function (err) {
        $('lobbyError').textContent = err.message;
      })
      .then(function () {
        setLobbyBusy(false);
      });
  }

  function setLobbyBusy(busy) {
    $('createBtn').disabled = busy;
    $('joinBtn').disabled = busy;
  }

  // -------------------------------------------------------------------------
  // Live updates
  // -------------------------------------------------------------------------

  function connectEvents() {
    closeEvents();
    setConnection(false);

    var url = '/api/events?room=' + encodeURIComponent(app.room) +
      '&token=' + encodeURIComponent(app.token);
    var source = new EventSource(url);
    app.es = source;

    source.onopen = function () {
      setConnection(true);
    };

    source.onerror = function () {
      setConnection(false);
      scheduleSessionCheck();
    };

    source.addEventListener('state', function (event) {
      try {
        var payload = JSON.parse(event.data);
        if (payload && payload.state) applyState(payload.state);
      } catch (err) {
        // ignore malformed event
      }
    });
  }

  function closeEvents() {
    if (app.es) {
      app.es.close();
      app.es = null;
    }
    clearTimeout(app.reconnectTimer);
    app.reconnectTimer = null;
  }

  function scheduleSessionCheck() {
    if (!app.room) return;
    clearTimeout(app.reconnectTimer);
    app.reconnectTimer = setTimeout(function () {
      if (!app.room) return;
      api('/api/session?room=' + encodeURIComponent(app.room) +
        '&token=' + encodeURIComponent(app.token))
        .catch(function (err) {
          if (err.status === 403 || err.status === 404) {
            sessionLost('That game is no longer available.');
          }
        });
    }, 2500);
  }

  function syncMusic() {
    var state = app.state;
    var active = Boolean(state && state.status === 'playing' && !state.game.over);
    // Keep the music running across tab switches; browsers suspend/resume the
    // AudioContext on their own, and we resume it when the tab becomes visible.
    sound.setMusicActive(active);
  }

  function applyState(state) {
    if (!state) return;

    if (state.timeControl) app.timeControl = state.timeControl;
    if (state.clock && typeof state.clock.since !== 'number') {
      state.clock = {
        w: state.clock.w,
        b: state.clock.b,
        active: state.clock.active,
        since: state.clock.active ? Date.now() : null
      };
    }

    var previous = app.state;
    var first = previous === null;
    app.state = state;

    if (first && !app.manualFlip) {
      app.flipped = app.color === 'b';
    }

    var game = state.game;
    if (game.over || game.turn !== app.color) {
      app.selected = null;
      app.legal = [];
    }

    if (!app.manualFlip && state.status === 'playing' && !state.game.over && state.game.turn === app.color) {
      app.flipped = app.color === 'b';
    }

    render();

    if (previous && previous.room === state.room) {
      if (game.moveLog.length > previous.game.moveLog.length) {
        sound.playForSan(game.moveLog[game.moveLog.length - 1].san);
      }

      var previousChat = previous.chat || [];
      var latestChat = state.chat && state.chat.length
        ? state.chat[state.chat.length - 1]
        : null;
      var previousChatId = previousChat.length
        ? previousChat[previousChat.length - 1].id
        : 0;

      if (latestChat && latestChat.id > previousChatId) {
        sound.playChat(latestChat.color === app.color);
      }
    }

    syncMusic();
  }

  function refreshFromServer() {
    if (!app.room) return;
    api('/api/session?room=' + encodeURIComponent(app.room) +
      '&token=' + encodeURIComponent(app.token))
      .then(function (data) {
        if (data.state) applyState(data.state);
      })
      .catch(function (err) {
        if (err.status === 403 || err.status === 404) sessionLost();
      });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    var state = app.state;
    if (!state) return;

    renderBoard();
    renderSeats();
    renderClocks();
    renderStatus();
    renderControls();
    renderOffers();
    renderChat();
    renderLog();

    $('waiting').classList.toggle('hidden', state.status !== 'waiting');
  }

  function renderBoard() {
    var state = app.state;
    var game = state.game;
    var boardEl = $('board');
    var fragment = document.createDocumentFragment();

    for (var displayRow = 0; displayRow < 8; displayRow++) {
      for (var displayCol = 0; displayCol < 8; displayCol++) {
        var r = app.flipped ? 7 - displayRow : displayRow;
        var c = app.flipped ? 7 - displayCol : displayCol;

        var cell = document.createElement('div');
        cell.className = 'cell ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);

        if (game.lastMove) {
          var from = game.lastMove.from;
          var to = game.lastMove.to;
          if ((from[0] === r && from[1] === c) || (to[0] === r && to[1] === c)) {
            cell.classList.add('last');
          }
        }

        if (app.selected && app.selected[0] === r && app.selected[1] === c) {
          cell.classList.add('sel');
        }

        var piece = game.board[r][c];

        if (game.inCheck && piece === game.turn + 'K') {
          cell.classList.add('check');
        }

        var isTarget = app.legal.some(function (move) {
          return move.to[0] === r && move.to[1] === c;
        });
        if (isTarget) cell.classList.add(piece ? 'capture-hint' : 'move-hint');

        if (piece) {
          var span = document.createElement('span');
          span.className = 'piece ' + piece[0];
          span.textContent = GLYPHS[piece[1]];
          cell.appendChild(span);
        }

        if (displayRow === 7) {
          var fileLabel = document.createElement('span');
          fileLabel.className = 'coord file';
          fileLabel.textContent = ENG.FILES[c];
          cell.appendChild(fileLabel);
        }

        if (displayCol === 0) {
          var rankLabel = document.createElement('span');
          rankLabel.className = 'coord rank';
          rankLabel.textContent = String(8 - r);
          cell.appendChild(rankLabel);
        }

        fragment.appendChild(cell);
      }
    }

    boardEl.replaceChildren(fragment);

    if (game.lastMove) {
      var fromR = app.flipped ? 7 - game.lastMove.from[0] : game.lastMove.from[0];
      var fromC = app.flipped ? 7 - game.lastMove.from[1] : game.lastMove.from[1];
      var toR = app.flipped ? 7 - game.lastMove.to[0] : game.lastMove.to[0];
      var toC = app.flipped ? 7 - game.lastMove.to[1] : game.lastMove.to[1];
      var moveKey = game.lastMove.from[0] + ',' + game.lastMove.from[1] + '->' +
        game.lastMove.to[0] + ',' + game.lastMove.to[1];

      if (moveKey !== app.animKey) {
        app.animKey = moveKey;
        var toEl = boardEl.querySelector('.cell[data-r="' + toR + '"][data-c="' + toC + '"] .piece');
        if (toEl) {
          var dx = (toC - fromC) * 100;
          var dy = (toR - fromR) * 100;
          toEl.style.transition = 'transform 180ms ease';
          toEl.style.transform = 'translate(' + dx + '%, ' + dy + '%)';
          void toEl.offsetWidth;
          toEl.style.transform = 'translate(0%, 0%)';
          toEl.addEventListener('transitionend', function () {
            toEl.style.transition = '';
            toEl.style.transform = '';
          }, { once: true });
        }
      }
    }
  }

  function renderSeats() {
    var state = app.state;
    var game = state.game;

    ['w', 'b'].forEach(function (color) {
      var seat = $('seat' + color.toUpperCase());
      var data = state.seats[color];
      var nameEl = seat.querySelector('.seat-name');
      var youEl = seat.querySelector('.seat-you');
      var turnEl = seat.querySelector('.seat-turn');
      var connEl = seat.querySelector('.seat-conn');

      setText(nameEl, data ? data.name : 'Waiting…');
      youEl.classList.toggle('hidden', app.color !== color);
      seat.classList.toggle('is-you', app.color === color);
      seat.classList.toggle('to-move',
        state.status === 'playing' && !game.over && game.turn === color);
      seat.classList.toggle('offline', !data || !data.connected);

      turnEl.classList.toggle('hidden',
        !(state.status === 'playing' && !game.over && game.turn === color));

      connEl.classList.toggle('online', Boolean(data && data.connected));
      connEl.classList.toggle('offline', !(data && data.connected));
    });
  }

  function renderClocks() {
    var state = app.state;
    var clock = state && state.clock;
    var label = $('timeControlLabel');

    ['w', 'b'].forEach(function (color) {
      var el = $('clock' + color.toUpperCase());
      if (!el) return;
      el.classList.toggle('hidden', !clock);
      if (!clock) return;

      var value = CLOCK.remaining(clock, color);
      el.textContent = CLOCK.format(value);
      el.classList.toggle('low', value <= 30000);
      el.classList.toggle('active', clock.active === color &&
        state.status === 'playing' && !state.game.over);
    });

    if (label) {
      label.classList.toggle('hidden', !clock);
      if (clock) label.textContent = 'Blitz · 10 minutes';
    }
  }

  function tickClocks() {
    var state = app.state;
    if (!state) return;

    if (state.clock && !app.room && state.status === 'playing' && !state.game.over) {
      var active = state.clock.active;
      if (active && CLOCK.remaining(state.clock, active) <= 0) {
        finishLocalTimeout(active);
        return;
      }
    }

    renderClocks();
  }

  function renderStatus() {
    var state = app.state;
    var game = state.game;
    var statusEl = $('status');
    var opponent = state.seats[other(app.color)];
    var text;
    var waiting = state.status === 'waiting';
    var alert = false;

    if (app.busy) {
      text = 'Sending move…';
    } else if (waiting) {
      text = 'Waiting for an opponent to join…';
    } else if (game.over) {
      text = game.result || 'Game over';
    } else if (!opponent) {
      text = 'Opponent left the game.';
      alert = true;
    } else if (!opponent.connected) {
      text = 'Opponent disconnected — waiting to reconnect…';
      alert = true;
    } else if (game.turn === app.color) {
      text = 'Your move' + (game.inCheck ? ' — check!' : '');
    } else {
      text = 'Opponent’s move' + (game.inCheck ? ' — check!' : '');
    }

    statusEl.textContent = text;
    statusEl.classList.toggle('waiting', waiting);
    statusEl.classList.toggle('alert', alert);
    statusEl.classList.toggle('over', Boolean(game.over));
  }

  function renderControls() {
    var state = app.state;
    var game = state.game;
    var playing = state.status === 'playing' && !game.over;
    var local = !app.room;
    var bothSeats = Boolean(state.seats.w && state.seats.b);
    var drawOffer = state.offers.draw;

    if (local) {
      // Local games have no network opponents, draw offers or rematches.
      $('drawBtn').disabled = true;
      $('resignBtn').disabled = true;
      $('rematchBtn').classList.add('hidden');
      return;
    }

    $('drawBtn').disabled = !playing || Boolean(drawOffer);
    setText($('drawBtn'), drawOffer === app.color ? 'Draw offered' : 'Offer draw');

    $('resignBtn').disabled = !playing;

    var rematchVisible = game.over && bothSeats;
    $('rematchBtn').classList.toggle('hidden', !rematchVisible);
    $('rematchBtn').disabled = rematchVisible &&
      state.offers.rematch.indexOf(app.color) !== -1;
    setText($('rematchBtn'),
      state.offers.rematch.indexOf(app.color) !== -1 ? 'Rematch offered' : 'Rematch');
  }

  function renderOffers() {
    var state = app.state;
    var game = state.game;
    var opponent = other(app.color);
    var bar = $('offerBar');
    var accept = $('acceptDrawBtn');
    var decline = $('declineDrawBtn');
    var text = '';
    var show = false;
    var canRespond = false;

    if (!game.over && state.offers.draw === opponent) {
      text = 'Opponent offers a draw.';
      show = true;
      canRespond = true;
    } else if (state.offers.draw === app.color && !game.over) {
      text = 'Draw offer sent — waiting for a reply.';
      show = true;
    } else if (state.offers.rematch.indexOf(opponent) !== -1) {
      text = 'Opponent wants a rematch.';
      show = true;
    } else if (state.offers.rematch.indexOf(app.color) !== -1) {
      text = 'Rematch offered — waiting for the opponent.';
      show = true;
    }

    bar.classList.toggle('hidden', !show);
    setText($('offerText'), text);
    accept.classList.toggle('hidden', !canRespond);
    decline.classList.toggle('hidden', !canRespond);
  }

  function renderChat() {
    var messages = app.state.chat || [];
    var signature = messages.map(function (message) { return message.id; }).join(',');

    if (signature === app.chatSignature) return;
    app.chatSignature = signature;

    var logEl = $('chatLog');
    var wasEmpty = app.chatCount === 0;
    var nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;

    app.chatCount = messages.length;

    if (!messages.length) {
      logEl.innerHTML = '<div class="chat-empty">No messages yet — say hello.</div>';
      return;
    }

    var fragment = document.createDocumentFragment();

    messages.forEach(function (message) {
      var row = document.createElement('div');
      row.className = 'chat-msg' + (message.color === app.color ? ' you' : '');

      var author = document.createElement('span');
      author.className = 'chat-author ' + message.color;
      author.textContent = message.name;

      var text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = message.text;

      row.append(author, text);
      fragment.appendChild(row);
    });

    logEl.replaceChildren(fragment);

    if (nearBottom || wasEmpty) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function sendChat() {
    var input = $('chatInput');
    var text = input.value.trim();

    if (!text || app.chatBusy || !app.room) return;

    app.chatBusy = true;
    $('chatSendBtn').disabled = true;

    api('/api/action', {
      room: app.room,
      token: app.token,
      action: 'chat',
      text: text
    }).then(function (data) {
      input.value = '';
      if (data.state) applyState(data.state);
      input.focus();
    }).catch(function (err) {
      toast(err.message);
    }).then(function () {
      app.chatBusy = false;
      $('chatSendBtn').disabled = false;
    });
  }

  function renderLog() {
    var log = app.state.game.moveLog;
    var movesEl = $('moves');

    if (!log.length) {
      movesEl.innerHTML = '<div class="empty-log">No moves yet.</div>';
      return;
    }

    var rows = [];
    for (var i = 0; i < log.length; i += 2) {
      var white = log[i];
      var black = log[i + 1];

      var row = document.createElement('div');
      row.className = 'move-row';

      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i / 2 + 1) + '.';

      var w = document.createElement('span');
      w.className = 'san';
      w.textContent = white ? white.san : '';

      var b = document.createElement('span');
      b.className = 'san' + (black ? '' : ' dim');
      b.textContent = black ? black.san : '—';

      row.append(num, w, b);
      rows.push(row);
    }

    movesEl.replaceChildren.apply(movesEl, rows);
    movesEl.scrollTop = movesEl.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // Moves
  // -------------------------------------------------------------------------

  function canInteract() {
    var state = app.state;
    if (!state || app.busy || app.promoMoves) return false;
    if (state.status !== 'playing' || state.game.over) return false;
    if (state.game.turn !== app.color) return false;
    if (!state.seats.w || !state.seats.b) return false;
    if (!state.seats[other(app.color)].connected) return false;
    return true;
  }

  function clearSelection(redraw) {
    app.selected = null;
    app.legal = [];
    if (redraw !== false) render();
  }

  function selectSquare(r, c) {
    app.selected = [r, c];
    app.legal = ENG.legalMovesFor(
      app.state.game.board, r, c, app.color,
      app.state.game.castling, app.state.game.ep
    );
    render();
  }

  function sendMove(move) {
    if (!app.room) {
      localMove(move);
      return;
    }

    app.busy = true;
    clearSelection(false);
    render();

    api('/api/move', {
      room: app.room,
      token: app.token,
      from: move.from,
      to: move.to,
      promo: move.promo || null
    }).then(function (data) {
      app.busy = false;
      if (data.state) applyState(data.state);
      else render();
    }).catch(function (err) {
      app.busy = false;
      toast(err.message);
      refreshFromServer();
      render();
    });
  }

  function showPromotion(moves) {
    app.promoMoves = moves;
    var options = $('promoOptions');
    options.innerHTML = '';

    ['Q', 'R', 'B', 'N'].forEach(function (type) {
      var button = document.createElement('button');
      button.type = 'button';
      button.title = { Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight' }[type];

      var span = document.createElement('span');
      span.className = 'piece ' + app.color;
      span.textContent = GLYPHS[type];
      button.appendChild(span);

      button.addEventListener('click', function () {
        var chosen = app.promoMoves && app.promoMoves.find(function (move) {
          return move.promo === type;
        });
        hidePromotion();
        if (chosen) sendMove(chosen);
      });

      options.appendChild(button);
    });

    $('promo').classList.remove('hidden');
  }

  function hidePromotion() {
    app.promoMoves = null;
    $('promo').classList.add('hidden');
    $('promoOptions').innerHTML = '';
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function sendAction(action, extra) {
    var payload = {
      room: app.room,
      token: app.token,
      action: action
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
      }
    }

    return api('/api/action', payload)
      .then(function (data) {
        if (action === 'leave') {
          clearStoredSession();
          showLobby();
          cleanUrl(null);
          toast('You left the room.');
          return;
        }
        if (data.state) applyState(data.state);
      })
      .catch(function (err) {
        toast(err.message);
        refreshFromServer();
      });
  }

  function resignGame() {
    if (!window.confirm('Resign this game?')) return;
    sendAction('resign');
  }

  function leaveGame() {
    if (app.room) {
      if (!window.confirm('Leave this room? If a game is in progress, your opponent wins.')) return;
      sendAction('leave');
    } else if (window.confirm('Leave this single player game?')) {
      showModeScreen();
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function bindEvents() {
    $('createBtn').addEventListener('click', createGame);
    $('joinBtn').addEventListener('click', joinGame);
    $('singlePlayerBtn').addEventListener('click', function () {
      showTimingScreen('single');
    });
    $('multiplayerBtn').addEventListener('click', startMultiplayer);
    $('timingBackBtn').addEventListener('click', showModeScreen);
    $('normalModeBtn').addEventListener('click', function () {
      chooseTimeControl('normal');
    });
    $('blitzModeBtn').addEventListener('click', function () {
      chooseTimeControl('blitz');
    });
    $('changeTimeBtn').addEventListener('click', function () {
      showTimingScreen('multi');
    });

    $('difficultySelect').addEventListener('change', function (event) {
      var value = event.target.value;
      if (!Object.prototype.hasOwnProperty.call(DIFFICULTIES, value)) return;
      app.difficulty = value;
      saveDifficulty(value);
    });

    $('soundBtn').addEventListener('click', function () {
      sound.toggle();
    });

    $('musicBtn').addEventListener('click', function () {
      sound.toggleMusic();
      syncMusic();
    });

    $('musicVolume').addEventListener('input', function (event) {
      var value = Number(event.target.value);
      if (isNaN(value)) return;
      sound.setMusicVolume(value / 100);
    });

    // Browsers only allow audio after a user gesture. Unlock on the first
    // pointer or key interaction so the opponent's moves can be heard too.
    document.addEventListener('pointerdown', function () {
      sound.unlock();
    }, { passive: true });

    document.addEventListener('keydown', function () {
      sound.unlock();
    });

    document.addEventListener('visibilitychange', function () {
      // Browsers suspend the AudioContext while the tab is hidden; make sure
      // it is running again when the tab becomes visible, and keep the music
      // going across tab switches.
      sound.resume();
      syncMusic();
    });

    $('codeInput').addEventListener('input', function (event) {
      event.target.value = event.target.value
        .toUpperCase()
        .replace(/[^A-Z2-9]/g, '')
        .slice(0, 5);
    });

    $('codeInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') joinGame();
    });

    $('nameInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') createGame();
    });

    $('drawBtn').addEventListener('click', function () {
      sendAction('offer-draw');
    });

    $('acceptDrawBtn').addEventListener('click', function () {
      sendAction('respond-draw', { accept: true });
    });

    $('declineDrawBtn').addEventListener('click', function () {
      sendAction('respond-draw', { accept: false });
    });

    $('resignBtn').addEventListener('click', resignGame);
    $('leaveBtn').addEventListener('click', leaveGame);

    $('rematchBtn').addEventListener('click', function () {
      sendAction('rematch');
    });

    $('chatForm').addEventListener('submit', function (event) {
      event.preventDefault();
      sendChat();
    });

    $('flipBtn').addEventListener('click', function () {
      app.flipped = !app.flipped;
      app.manualFlip = true;
      render();
    });

    $('copyLinkBtn').addEventListener('click', function () {
      copyText(inviteLink());
    });

    $('roomBadge').addEventListener('click', function () {
      copyText(inviteLink());
    });

    $('board').addEventListener('click', function (event) {
      if (!canInteract()) return;

      var cell = event.target.closest('.cell');
      if (!cell) return;

      var r = Number(cell.dataset.r);
      var c = Number(cell.dataset.c);
      var game = app.state.game;

      if (app.selected) {
        var candidates = app.legal.filter(function (move) {
          return move.to[0] === r && move.to[1] === c;
        });

        if (candidates.length) {
          if (candidates[0].promo) showPromotion(candidates);
          else sendMove(candidates[0]);
          return;
        }
      }

      var piece = game.board[r][c];

      if (piece && piece[0] === app.color) {
        if (app.selected && app.selected[0] === r && app.selected[1] === c) {
          clearSelection();
        } else {
          selectSquare(r, c);
        }
      } else {
        clearSelection();
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && app.promoMoves) {
        hidePromotion();
        render();
      }
    });

    window.addEventListener('beforeunload', function () {
      if (app.es) app.es.close();
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function init() {
    bindEvents();
    sound.updateButtons();
    $('musicVolume').value = String(Math.round(sound.getMusicVolume() * 100));

    app.difficulty = readStoredDifficulty();
    $('difficultySelect').value = app.difficulty;

    window.setInterval(tickClocks, 200);

    $('nameInput').value = readStoredName();

    var params = new URLSearchParams(location.search);
    var urlRoom = (params.get('room') || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5);
    var urlToken = params.get('token') || '';

    if (urlRoom) $('codeInput').value = urlRoom;

    var stored = readStoredSession();
    var session = null;

    if (urlRoom.length === 5 && urlToken) {
      session = { room: urlRoom, token: urlToken };
    } else if (stored && (!urlRoom || stored.room === urlRoom)) {
      session = stored;
    }

    if (session) {
      resumeSession(session);
    } else {
      showModeScreen();
    }
  }

  init();
})();
