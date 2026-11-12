'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

let server;
let base;
const openStreams = [];

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  for (const stream of openStreams) stream.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function request(method, path, body) {
  const options = { method, cache: 'no-store' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = null;
  }
  return { status: response.status, headers: response.headers, data, text };
}

function post(path, body) {
  return request('POST', path, body);
}

function get(path) {
  return request('GET', path);
}

function createStream(room, token) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];

  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter.predicate(events.slice(waiter.from))) {
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(events);
      }
    }
  };

  const ready = fetch(
    base + '/api/events?room=' + encodeURIComponent(room) + '&token=' + encodeURIComponent(token),
    { signal: controller.signal }
  ).then((response) => {
    assert.equal(response.status, 200, 'SSE should connect');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let index;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
            if (!dataLine) continue;
            try {
              events.push(JSON.parse(dataLine.slice(5).trim()));
            } catch (err) {
              // ignore malformed frame
            }
          }
          notify();
        }
      } catch (err) {
        if (err.name !== 'AbortError') throw err;
      }
    })();

    return response;
  });

  const stream = {
    events,
    ready,
    waitFor(predicate, label, from = 0, timeout = 3000) {
      if (predicate(events.slice(from))) return Promise.resolve(events);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for ' + label + '. Saw: ' +
            JSON.stringify(events.map((event) => event.state && {
              status: event.state.status,
              turn: event.state.game.turn,
              draw: event.state.offers.draw,
              rematch: event.state.offers.rematch,
              seats: event.state.seats
            }))));
        }, timeout);
        waiters.push({ predicate, resolve, timer, from });
      });
    },
    close() {
      controller.abort();
    }
  };

  openStreams.push(stream);
  return stream;
}

function lastState(result) {
  return result.data.state;
}

test('static assets and API validation', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(index.text, /MultiChess/);

  const css = await get('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const engine = await get('/engine.js');
  assert.equal(engine.status, 200);

  assert.equal((await get('/missing.js')).status, 404);
  assert.equal((await get('/api/nope')).status, 404);
  assert.equal((await post('/api/create', '{oops')).status, 400);

  const badCode = await post('/api/join', { room: 'nope' });
  assert.equal(badCode.status, 400);

  const unknown = await post('/api/join', { room: 'ZZZZZ', name: 'Nobody' });
  assert.equal(unknown.status, 404);
});

test('full room lifecycle over HTTP and SSE', async () => {
  const created = await post('/api/create', { name: 'Alice' });
  assert.equal(created.status, 201);
  assert.equal(created.data.ok, true);
  assert.equal(created.data.color, 'w');
  assert.match(created.data.room, /^[A-Z2-9]{5}$/);

  const room = created.data.room;
  const whiteToken = created.data.token;
  const initial = lastState(created);
  assert.equal(initial.status, 'waiting');
  assert.equal(initial.seats.w.name, 'Alice');
  assert.equal(initial.seats.b, null);

  const joined = await post('/api/join', { room, name: 'Bob' });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.color, 'b');
  assert.equal(lastState(joined).status, 'playing');
  assert.equal(lastState(joined).seats.b.name, 'Bob');

  const blackToken = joined.data.token;

  const duplicate = await post('/api/join', { room, name: 'Eve' });
  assert.equal(duplicate.status, 409);

  const session = await get('/api/session?room=' + room + '&token=' + encodeURIComponent(whiteToken));
  assert.equal(session.status, 200);
  assert.equal(session.data.color, 'w');
  assert.equal(session.data.name, 'Alice');
  assert.equal(session.data.state.status, 'playing');

  assert.equal((await get('/api/session?room=' + room + '&token=wrong')).status, 403);

  let white = createStream(room, whiteToken);
  const black = createStream(room, blackToken);
  await Promise.all([white.ready, black.ready]);

  // Both streams should learn the other player is connected.
  await white.waitFor((events) => events.some((event) => event.state.seats.b.connected),
    'white sees black connected');
  await black.waitFor((events) => events.some((event) => event.state.seats.w.connected),
    'black sees white connected');

  // Disconnect detection and resume with the same token.
  let mark = black.events.length;
  white.close();
  await black.waitFor((events) => events.some((event) => !event.state.seats.w.connected),
    'black sees white disconnect', mark);
  mark = black.events.length;
  white = createStream(room, whiteToken);
  await white.ready;
  await black.waitFor((events) => events.some((event) => event.state.seats.w.connected),
    'black sees white reconnect', mark);

  // Turn enforcement and illegal moves are rejected by the server.
  const outOfTurn = await post('/api/move', {
    room, token: blackToken, from: [1, 4], to: [3, 4]
  });
  assert.equal(outOfTurn.status, 409);
  assert.match(outOfTurn.data.error, /not your turn/i);

  const illegal = await post('/api/move', {
    room, token: whiteToken, from: [6, 4], to: [3, 4]
  });
  assert.equal(illegal.status, 422);
  assert.match(illegal.data.error, /illegal/i);

  const malformed = await post('/api/move', {
    room, token: whiteToken, from: 'e2', to: 'e4'
  });
  assert.equal(malformed.status, 422);

  assert.equal((await post('/api/move', {
    room, token: 'nobody', from: [6, 4], to: [4, 4]
  })).status, 403);

  // Legal white move is applied and streamed to black.
  mark = black.events.length;
  const e4 = await post('/api/move', {
    room, token: whiteToken, from: [6, 4], to: [4, 4]
  });
  assert.equal(e4.status, 200);
  assert.equal(lastState(e4).game.turn, 'b');
  assert.equal(lastState(e4).game.moveLog[0].san, 'e4');
  assert.equal(lastState(e4).game.fullmove, 1);

  await black.waitFor((events) => events.some((event) =>
    event.state.game.moveLog.length === 1 &&
    event.state.game.moveLog[0].san === 'e4' &&
    event.state.game.turn === 'b'), 'black receives e4', mark);

  // Black replies; the turn returns to White.
  const e5 = await post('/api/move', {
    room, token: blackToken, from: [1, 4], to: [3, 4]
  });
  assert.equal(e5.status, 200);
  assert.equal(lastState(e5).game.turn, 'w');
  assert.equal(lastState(e5).game.moveLog[1].san, 'e5');
  assert.equal(lastState(e5).game.fullmove, 2);

  // Chat is sanitized, stored with the author, and streamed to the opponent.
  mark = black.events.length;
  const chat = await post('/api/action', {
    room, token: whiteToken, action: 'chat', text: '  hello \n  Bob  '
  });
  assert.equal(chat.status, 200);
  assert.equal(lastState(chat).chat.length, 1);
  assert.equal(lastState(chat).chat[0].id, 1);
  assert.equal(lastState(chat).chat[0].color, 'w');
  assert.equal(lastState(chat).chat[0].name, 'Alice');
  assert.equal(lastState(chat).chat[0].text, 'hello Bob');
  assert.equal(typeof lastState(chat).chat[0].at, 'number');

  await black.waitFor((events) => events.some((event) =>
    event.state.chat.some((message) => message.text === 'hello Bob')),
    'black receives chat', mark);

  const emptyChat = await post('/api/action', {
    room, token: blackToken, action: 'chat', text: '   \n  '
  });
  assert.equal(emptyChat.status, 400);

  const longChat = await post('/api/action', {
    room, token: blackToken, action: 'chat', text: 'x'.repeat(400)
  });
  assert.equal(longChat.status, 200);
  assert.equal(lastState(longChat).chat.length, 2);
  assert.equal(lastState(longChat).chat[1].text.length, 300);
  assert.equal(lastState(longChat).chat[1].name, 'Bob');

  assert.equal((await post('/api/action', {
    room, token: 'nobody', action: 'chat', text: 'sneaky'
  })).status, 403);

  // Draw offer is visible to the opponent, and accepting ends the game.
  const offered = await post('/api/action', { room, token: whiteToken, action: 'offer-draw' });
  assert.equal(offered.status, 200);
  assert.equal(lastState(offered).offers.draw, 'w');

  mark = black.events.length;
  await black.waitFor((events) => events.some((event) => event.state.offers.draw === 'w'),
    'black sees draw offer', mark);

  const selfAccept = await post('/api/action', {
    room, token: whiteToken, action: 'respond-draw', accept: true
  });
  assert.equal(selfAccept.status, 409);

  const accepted = await post('/api/action', {
    room, token: blackToken, action: 'respond-draw', accept: true
  });
  assert.equal(accepted.status, 200);
  assert.equal(lastState(accepted).game.over, true);
  assert.equal(lastState(accepted).status, 'over');
  assert.equal(lastState(accepted).game.result, 'Draw — agreed');
  assert.equal(lastState(accepted).offers.draw, null);

  // Rematch requires both players and resets the board with the same colors.
  mark = white.events.length;
  const firstRematch = await post('/api/action', { room, token: whiteToken, action: 'rematch' });
  assert.equal(firstRematch.status, 200);
  assert.equal(lastState(firstRematch).status, 'over');
  assert.deepEqual(lastState(firstRematch).offers.rematch, ['w']);

  const secondRematch = await post('/api/action', { room, token: blackToken, action: 'rematch' });
  assert.equal(secondRematch.status, 200);
  assert.equal(lastState(secondRematch).status, 'playing');
  assert.equal(lastState(secondRematch).game.over, false);
  assert.equal(lastState(secondRematch).game.turn, 'w');
  assert.equal(lastState(secondRematch).game.moveLog.length, 0);
  assert.equal(lastState(secondRematch).game.board[6][4], 'wP');
  assert.equal(lastState(secondRematch).game.board[4][4], null);
  assert.equal(lastState(secondRematch).chat.length, 2);
  assert.equal(lastState(secondRematch).chat[0].text, 'hello Bob');

  await white.waitFor((events) => events.some((event) =>
    event.state.status === 'playing' &&
    event.state.game.moveLog.length === 0 &&
    event.state.offers.rematch.length === 0), 'white sees rematch reset', mark);

  // Resigning awards the game to the opponent.
  const resigned = await post('/api/action', { room, token: whiteToken, action: 'resign' });
  assert.equal(resigned.status, 200);
  assert.equal(lastState(resigned).status, 'over');
  assert.match(lastState(resigned).game.result, /Black wins.*White resigned/);

  // Leaving after the game frees the seat; the last player out deletes the room.
  const blackLeft = await post('/api/action', { room, token: blackToken, action: 'leave' });
  assert.equal(blackLeft.status, 200);
  assert.equal(lastState(blackLeft).seats.b, null);
  assert.equal(lastState(blackLeft).seats.w.name, 'Alice');

  const whiteLeft = await post('/api/action', { room, token: whiteToken, action: 'leave' });
  assert.equal(whiteLeft.status, 200);
  assert.equal(whiteLeft.data.state, null);

  assert.equal((await get('/api/session?room=' + room + '&token=' + encodeURIComponent(whiteToken))).status, 404);
});

test('leaving a game in progress and leaving a waiting room', async () => {
  const created = await post('/api/create', { name: 'One' });
  const room = created.data.room;
  const whiteToken = created.data.token;
  const joined = await post('/api/join', { room, name: 'Two' });
  const blackToken = joined.data.token;

  const left = await post('/api/action', { room, token: whiteToken, action: 'leave' });
  assert.equal(left.status, 200);
  assert.equal(lastState(left).status, 'over');
  assert.match(lastState(left).game.result, /Black wins.*opponent left/);
  assert.equal(lastState(left).seats.w, null);

  await post('/api/action', { room, token: blackToken, action: 'leave' });

  const waiting = await post('/api/create', { name: 'Solo' });
  const waitingRoom = waiting.data.room;
  const waitingToken = waiting.data.token;

  const abandoned = await post('/api/action', {
    room: waitingRoom, token: waitingToken, action: 'leave'
  });
  assert.equal(abandoned.status, 200);
  assert.equal(abandoned.data.state, null);

  assert.equal((await get('/api/session?room=' + waitingRoom +
    '&token=' + encodeURIComponent(waitingToken))).status, 404);
});

test('move bodies must be small valid JSON with room codes', async () => {
  const created = await post('/api/create', { name: 'Size' });
  const room = created.data.room;

  const unknownAction = await post('/api/action', {
    room, token: created.data.token, action: 'explode'
  });
  assert.equal(unknownAction.status, 400);

  const missingRoom = await post('/api/move', {
    token: created.data.token, from: [6, 4], to: [4, 4]
  });
  assert.equal(missingRoom.status, 404);

  const huge = await post('/api/create', { name: 'x'.repeat(20 * 1024) });
  assert.equal(huge.status, 413);
});
