'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const chess = require('./public/engine.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOMS = new Map();
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CHAT_LENGTH = 300;
const MAX_CHAT_HISTORY = 100;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function newRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  } while (ROOMS.has(code));
  return code;
}

function createRoom(whiteName) {
  const code = newRoomCode();
  const room = {
    code,
    game: chess.createGame(),
    seats: {
      w: { token: newToken(), name: whiteName },
      b: null
    },
    connected: { w: false, b: false },
    streams: { w: new Set(), b: new Set() },
    status: 'waiting',
    drawOffer: null,
    rematch: new Set(),
    chat: [],
    chatSeq: 0,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  ROOMS.set(code, room);
  return room;
}

function seatColorForToken(room, token) {
  if (!token) return null;
  if (room.seats.w && room.seats.w.token === token) return 'w';
  if (room.seats.b && room.seats.b.token === token) return 'b';
  return null;
}

function snapshot(room) {
  return {
    room: room.code,
    status: room.status,
    seats: {
      w: room.seats.w
        ? { name: room.seats.w.name, connected: room.connected.w }
        : null,
      b: room.seats.b
        ? { name: room.seats.b.name, connected: room.connected.b }
        : null
    },
    game: room.game,
    offers: {
      draw: room.drawOffer,
      rematch: Array.from(room.rematch)
    },
    chat: room.chat
  };
}

function broadcast(room) {
  if (!ROOMS.has(room.code)) return;
  const frame = 'event: state\ndata: ' +
    JSON.stringify({ type: 'state', state: snapshot(room) }) + '\n\n';

  for (const color of ['w', 'b']) {
    for (const stream of room.streams[color]) {
      if (!stream.writableEnded) {
        try {
          stream.write(frame);
        } catch (err) {
          // A closed stream is cleaned up by its own close handler.
        }
      }
    }
  }
}

function resetGame(room) {
  room.game = chess.createGame();
  room.status = 'playing';
  room.drawOffer = null;
  room.rematch.clear();
  room.lastActivity = Date.now();
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function cleanName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return cleaned || fallback;
}

function cleanCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z2-9]{5}$/.test(code) ? code : null;
}

function cleanMessage(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LENGTH);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;

    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (failed) return;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 }));
      }
    });

    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function serveStatic(res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch (err) {
    sendText(res, 400, 'Bad request');
    return;
  }

  if (relative === '/' || relative === '') relative = '/index.html';
  if (relative.includes('\0')) {
    sendText(res, 400, 'Bad request');
    return;
  }

  const filePath = path.resolve(PUBLIC_DIR, '.' + relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 404, 'Not found');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'"
    });

    if (res.req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleCreate(req, res) {
  const body = await readJsonBody(req);
  const name = cleanName(body.name, 'White');
  const room = createRoom(name);

  sendJson(res, 201, {
    ok: true,
    room: room.code,
    token: room.seats.w.token,
    color: 'w',
    name,
    state: snapshot(room)
  });
}

async function handleJoin(req, res) {
  const body = await readJsonBody(req);
  const code = cleanCode(body.room);
  if (!code) {
    sendError(res, 400, 'Enter a valid room code.');
    return;
  }

  const room = ROOMS.get(code);
  if (!room) {
    sendError(res, 404, 'Room not found. Check the code and try again.');
    return;
  }
  if (room.status !== 'waiting' || room.seats.b) {
    sendError(res, 409, 'That room is no longer accepting players.');
    return;
  }

  const name = cleanName(body.name, 'Black');
  room.seats.b = { token: newToken(), name };
  room.status = 'playing';
  room.lastActivity = Date.now();
  broadcast(room);

  sendJson(res, 200, {
    ok: true,
    room: room.code,
    token: room.seats.b.token,
    color: 'b',
    name,
    state: snapshot(room)
  });
}

async function handleMove(req, res) {
  const body = await readJsonBody(req);
  const room = ROOMS.get(cleanCode(body.room));
  if (!room) {
    sendError(res, 404, 'Room not found.');
    return;
  }

  const color = seatColorForToken(room, body.token);
  if (!color) {
    sendError(res, 403, 'You are not a player in this room.');
    return;
  }
  if (room.status !== 'playing' || room.game.over) {
    sendError(res, 409, 'The game is not in progress.');
    return;
  }
  if (room.seats.w === null || room.seats.b === null) {
    sendError(res, 409, 'Waiting for an opponent.');
    return;
  }
  if (room.game.turn !== color) {
    sendError(res, 409, 'It is not your turn.');
    return;
  }

  const promo = typeof body.promo === 'string' ? body.promo.toUpperCase() : null;
  const move = chess.findLegalMove(room.game, body.from, body.to, promo);
  if (!move) {
    sendError(res, 422, 'Illegal move.');
    return;
  }

  chess.makeMove(room.game, move);
  room.drawOffer = null;
  room.rematch.clear();
  room.lastActivity = Date.now();
  if (room.game.over) room.status = 'over';

  broadcast(room);
  sendJson(res, 200, { ok: true, state: snapshot(room) });
}

async function handleAction(req, res) {
  const body = await readJsonBody(req);
  const room = ROOMS.get(cleanCode(body.room));
  if (!room) {
    sendError(res, 404, 'Room not found.');
    return;
  }

  const color = seatColorForToken(room, body.token);
  if (!color) {
    sendError(res, 403, 'You are not a player in this room.');
    return;
  }

  const opponent = color === 'w' ? 'b' : 'w';
  const action = body.action;

  if (action === 'resign') {
    if (room.status !== 'playing' || room.game.over) {
      sendError(res, 409, 'The game is not in progress.');
      return;
    }
    room.game.over = true;
    room.status = 'over';
    room.game.result = chess.colorName(opponent) + ' wins — ' +
      chess.colorName(color) + ' resigned';
    room.drawOffer = null;
    room.rematch.clear();
  } else if (action === 'offer-draw') {
    if (room.status !== 'playing' || room.game.over) {
      sendError(res, 409, 'The game is not in progress.');
      return;
    }
    if (room.drawOffer && room.drawOffer !== color) {
      sendError(res, 409, 'Your opponent has already offered a draw.');
      return;
    }
    room.drawOffer = color;
  } else if (action === 'respond-draw') {
    if (!room.drawOffer || room.drawOffer === color) {
      sendError(res, 409, 'There is no draw offer to respond to.');
      return;
    }
    if (body.accept === true) {
      room.game.over = true;
      room.status = 'over';
      room.game.result = 'Draw — agreed';
      room.rematch.clear();
    }
    room.drawOffer = null;
  } else if (action === 'rematch') {
    if (room.status !== 'over') {
      sendError(res, 409, 'The game is still in progress.');
      return;
    }
    if (!room.seats.w || !room.seats.b) {
      sendError(res, 409, 'Both players need to be present for a rematch.');
      return;
    }
    room.rematch.add(color);
    if (room.rematch.size === 2) resetGame(room);
  } else if (action === 'chat') {
    const text = cleanMessage(body.text);
    if (!text) {
      sendError(res, 400, 'Type a message first.');
      return;
    }

    room.chatSeq += 1;
    room.chat.push({
      id: room.chatSeq,
      color,
      name: room.seats[color].name,
      text,
      at: Date.now()
    });
    if (room.chat.length > MAX_CHAT_HISTORY) {
      room.chat.splice(0, room.chat.length - MAX_CHAT_HISTORY);
    }
  } else if (action === 'leave') {
    const opponentSeat = room.seats[opponent];

    room.seats[color] = null;
    room.connected[color] = false;
    for (const stream of room.streams[color]) {
      try {
        stream.end();
      } catch (err) {
        // ignore
      }
    }
    room.streams[color].clear();
    room.rematch.delete(color);
    if (room.drawOffer === color) room.drawOffer = null;

    if (room.status === 'playing' && !room.game.over && opponentSeat) {
      room.game.over = true;
      room.status = 'over';
      room.game.result = chess.colorName(opponent) + ' wins — opponent left';
      room.drawOffer = null;
    }

    room.lastActivity = Date.now();

    if (!room.seats.w && !room.seats.b) {
      ROOMS.delete(room.code);
      sendJson(res, 200, { ok: true, state: null });
      return;
    }
  } else {
    sendError(res, 400, 'Unknown action.');
    return;
  }

  room.lastActivity = Date.now();
  broadcast(room);
  sendJson(res, 200, { ok: true, state: snapshot(room) });
}

function handleSession(res, url) {
  const room = ROOMS.get(cleanCode(url.searchParams.get('room')));
  if (!room) {
    sendError(res, 404, 'Game not found.');
    return;
  }

  const token = url.searchParams.get('token') || '';
  const color = seatColorForToken(room, token);
  if (!color) {
    sendError(res, 403, 'That seat is no longer available.');
    return;
  }

  const seat = room.seats[color];
  sendJson(res, 200, {
    ok: true,
    room: room.code,
    color,
    name: seat.name,
    state: snapshot(room)
  });
}

function handleEvents(req, res, url) {
  const room = ROOMS.get(cleanCode(url.searchParams.get('room')));
  const token = url.searchParams.get('token') || '';
  const color = room ? seatColorForToken(room, token) : null;

  if (!room || !color) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 1500\n\n');

  const writeState = () => {
    if (!res.writableEnded) {
      res.write('event: state\ndata: ' +
        JSON.stringify({ type: 'state', state: snapshot(room) }) + '\n\n');
    }
  };

  writeState();
  room.streams[color].add(res);
  room.connected[color] = true;
  room.lastActivity = Date.now();
  broadcast(room);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    const streams = room.streams[color];
    streams.delete(res);
    if (ROOMS.get(room.code) === room) {
      room.connected[color] = streams.size > 0;
      broadcast(room);
    }
    if (!res.writableEnded) res.end();
  };

  const heartbeat = setInterval(() => {
    if (!ROOMS.has(room.code) || seatColorForToken(room, token) !== color) {
      cleanup();
      return;
    }
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/events') {
    handleEvents(req, res, url);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/session') {
    handleSession(res, url);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/create') {
    await handleCreate(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/join') {
    await handleJoin(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/move') {
    await handleMove(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/action') {
    await handleAction(req, res);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendError(res, 404, 'Unknown API endpoint.');
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(res, pathname);
    return;
  }

  sendError(res, 405, 'Method not allowed.');
}

function handleRequest(req, res) {
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      const status = err && err.status ? err.status : 500;
      if (!res.headersSent) {
        sendError(res, status, status === 500 ? 'Internal server error.' : err.message);
      } else if (!res.writableEnded) {
        res.end();
      }
      if (status === 500) console.error(err);
    });
}

function createServer() {
  return http.createServer(handleRequest);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function lanAddresses() {
  const found = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const family = typeof iface.family === 'string' ? iface.family : String(iface.family);
      if ((family === 'IPv4' || family === '4') && !iface.internal) {
        found.push({ name, address: iface.address });
      }
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  return found;
}

function start() {
  let port = Number(process.env.PORT) || 8080;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      const parsed = Number(args[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) port = parsed;
    }
  }

  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' is already in use. Try: node server.js --port 8081');
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    const addresses = lanAddresses();
    console.log('');
    console.log('  MultiChess is running');
    console.log('  ---------------------');
    console.log('  Local:   http://localhost:' + port);
    for (const iface of addresses) {
      console.log('  Network (' + iface.name + '): http://' + iface.address + ':' + port + '   <- open on the other machine');
    }
    console.log('');
    console.log('  Both machines must be on the same Wi-Fi / network.');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of ROOMS) {
      const connected = room.connected.w || room.connected.b;
      if (!connected && now - room.lastActivity > ROOM_TTL_MS) {
        ROOMS.delete(code);
      }
    }
  }, 10 * 60 * 1000);
  cleanup.unref();

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { createServer, start, ROOMS };
