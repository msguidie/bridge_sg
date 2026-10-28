const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const {
  createInitialGameState,
  clientViewForPlayer,
  processAction,
  resolvePendingTrick,
  processResign,
  calculateRatingChanges,
  updateTimeControl,
  consumeTurnTime,
  addTimeIncrement,
  startTurnTimeControl,
  pauseTurnTimeControl,
} = require('./gameLogic');
const replayRecorder = require('./replayRecorder');
const replayStore = require('./replayStore');
const accountStore = require('./accountStore');

const app = express();
app.use(cors());
app.use(express.json());

// ── Health & Status endpoints ──
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now(), uptime: process.uptime() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  connectTimeout: 45000,
});

// A seat that stays disconnected this long forfeits (as a timeout).
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 2 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
// Accounts (Initial rating = 0, wins +1 / losses -1)
// Persisted by accountStore: local file + GitHub replay repo when configured.
// ═══════════════════════════════════════════════════════════

const { accounts } = accountStore;

app.get('/api/accounts', async (_req, res) => {
  await accountStore.ready;
  res.json(
    Object.values(accounts).sort((a, b) => (b.rating || 0) - (a.rating || 0)),
  );
});

app.post('/api/accounts', async (req, res) => {
  await accountStore.ready;
  const { username } = req.body || {};
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const trimmed = username.trim().slice(0, 16);
  if (accounts[trimmed]) {
    return res.status(409).json({ error: 'Account already exists' });
  }
  const acct = {
    username: trimmed,
    avatarSeed: Math.floor(Math.random() * 100000),
    rating: 0,
    gamesPlayed: 0,
    wins: 0,
    createdAt: Date.now(),
  };
  accounts[trimmed] = acct;
  accountStore.save();
  res.status(201).json(acct);
});

// ═══════════════════════════════════════════════════════════
// Replay REST API (mirrored from 08162026-main/server/index.js)
// ═══════════════════════════════════════════════════════════

function replaySafe(fn) {
  try {
    fn();
  } catch (err) {
    console.error('[replay] hook failed:', err?.message || err);
  }
}

app.get('/api/replays', async (req, res) => {
  try {
    res.json(await replayStore.listGames({ limit: req.query.limit, offset: req.query.offset }));
  } catch (err) {
    console.error('[replay] list failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to list replays' });
  }
});

app.get('/api/replays/status', (_req, res) => {
  res.json(replayStore.status());
});

app.get('/api/replays/:id', async (req, res) => {
  if (!replayStore.isValidReplayId(req.params.id)) {
    res.status(404).json({ error: 'Replay not found' });
    return;
  }
  try {
    const data = await replayStore.getFrames(req.params.id);
    if (!data) {
      res.status(404).json({ error: 'Replay not found' });
      return;
    }
    res.json({ id: req.params.id, meta: data.meta, frames: data.frames });
  } catch (err) {
    if (err?.name === 'ReplayCorruptError') {
      res.status(422).json({ error: err.message, actionIndex: err.actionIndex });
      return;
    }
    console.error('[replay] reconstruct failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to reconstruct replay' });
  }
});

app.get('/api/replays/:id/raw', async (req, res) => {
  if (!replayStore.isValidReplayId(req.params.id)) {
    res.status(404).json({ error: 'Replay not found' });
    return;
  }
  try {
    const json = await replayStore.getReplay(req.params.id);
    if (!json) {
      res.status(404).json({ error: 'Replay not found' });
      return;
    }
    res.json(json);
  } catch (err) {
    console.error('[replay] raw fetch failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to read replay' });
  }
});

// ═══════════════════════════════════════════════════════════
// Waiting Room (Lobby) — Strictly 4 players
// ═══════════════════════════════════════════════════════════

let waitingRoom = {
  players: [], // { socketId, username, avatarSeed, ready, wantsFirst }
  unlimitedTime: false,
};

function lobbySnapshot() {
  return {
    players: waitingRoom.players.map(p => ({
      username: p.username,
      avatarSeed: p.avatarSeed,
      ready: p.ready,
      wantsFirst: !!p.wantsFirst,
    })),
    unlimitedTime: !!waitingRoom.unlimitedTime,
  };
}

function broadcastLobby() {
  const payload = lobbySnapshot();
  for (const p of waitingRoom.players) {
    io.to(p.socketId).emit('lobby_update', payload);
  }
}

function removeFromLobby(socketId) {
  const before = waitingRoom.players.length;
  waitingRoom.players = waitingRoom.players.filter(p => p.socketId !== socketId);
  if (waitingRoom.players.length !== before) broadcastLobby();
}

// ═══════════════════════════════════════════════════════════
// Active Game Rooms
// ═══════════════════════════════════════════════════════════

const gameRooms = new Map();

function findActiveGame(username) {
  for (const [roomId, room] of gameRooms) {
    if (room.state.phase === 'GAME_OVER') continue;
    const seat = room.players.findIndex(p => p.username === username);
    if (seat !== -1) return { roomId, room, seat };
  }
  return null;
}

// Game view plus each seat's connection state (kept on the room, not in game state).
function viewFor(room, seat) {
  const view = clientViewForPlayer(room.state, seat);
  view.serverNow = Date.now();
  view.players.forEach((p, idx) => {
    const rp = room.players[idx];
    p.connected = !!rp?.connected;
    p.disconnectDeadline =
      rp && !rp.connected && rp.disconnectedAt ? rp.disconnectedAt + DISCONNECT_GRACE_MS : null;
  });
  return view;
}

function emitGameStateToRoom(room, eventName = 'game_state_update', extraPayload = {}) {
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!p.socketId) continue;
    io.to(p.socketId).emit(eventName, {
      ...extraPayload,
      roomId: room.id,
      state: viewFor(room, i),
    });
  }
}

function finalizeFinishedGame(room) {
  if (!room || room.ratingsCommitted || room.state.phase !== 'GAME_OVER') return;
  room.ratingsCommitted = true;

  if (room.trickResolveTimer) {
    clearTimeout(room.trickResolveTimer);
    room.trickResolveTimer = null;
  }

  const changes =
    room.state.gameResult?.ratingChanges || calculateRatingChanges(room.state);

  for (let i = 0; i < room.state.players.length; i++) {
    const gp = room.state.players[i];
    const acct = accounts[gp.username];
    if (acct) {
      acct.gamesPlayed += 1;
      const delta = changes[i] ?? 0;
      if (delta > 0) acct.wins += 1;
      acct.rating = (acct.rating || 0) + delta;
    }
  }
  accountStore.save();
  replaySafe(() => replayRecorder.finish(room));
}

function forfeitOnTimeout(room, seat) {
  if (room.trickResolveTimer) {
    clearTimeout(room.trickResolveTimer);
    room.trickResolveTimer = null;
  }
  processResign(room.state, seat, 'TIMEOUT');
  replaySafe(() => replayRecorder.onTimeout(room, seat));
  finalizeFinishedGame(room);
  emitGameStateToRoom(room, 'game_state_update', {
    lastAction: { type: 'TIMEOUT', actingPlayer: seat, payload: {} },
  });
}

function scheduleTrickResolve(room) {
  if (room.trickResolveTimer) {
    clearTimeout(room.trickResolveTimer);
    room.trickResolveTimer = null;
  }
  if (!room.state.trickPendingResolve) return;

  const delay = Math.max(100, room.state.trickPendingResolve.resolveAt - Date.now());
  room.trickResolveTimer = setTimeout(() => {
    room.trickResolveTimer = null;
    if (!gameRooms.has(room.id)) return;
    if (!room.state.trickPendingResolve || room.state.phase !== 'PLAYING') return;

    try {
      const now = Date.now();
      const res = resolvePendingTrick(room.state, now);
      if (!res) return;

      const nextPlayer = room.players[room.state.currentPlayerIndex];
      if (!res.gameOver && nextPlayer && !nextPlayer.connected) {
        startTurnTimeControl(room.state, now, true);
      }

      if (room.state.phase === 'GAME_OVER') {
        finalizeFinishedGame(room);
      }

      emitGameStateToRoom(room, 'game_state_update', {
        lastAction: {
          type: 'TRICK_RESOLVED',
          actingPlayer: res.winnerIndex,
          payload: { winnerIndex: res.winnerIndex },
        },
      });
    } catch (err) {
      console.error(`[room ${room.id}] trick resolve failed:`, err);
    }
  }, delay);
}

function checkGameStart() {
  const ps = waitingRoom.players;
  if (ps.length !== 4) return;
  if (!ps.every(p => p.ready)) return;

  const now = Date.now();
  const roomId = `game-${now}-${Math.random().toString(36).slice(2, 6)}`;
  const roomPlayers = ps.map((p, idx) => ({
    socketId: p.socketId,
    username: p.username,
    avatarSeed: p.avatarSeed,
    seatIndex: idx,
    connected: true,
    disconnectedAt: null,
    wantsFirst: !!p.wantsFirst,
  }));

  const preferredIndices = roomPlayers
    .map((p, idx) => (p.wantsFirst ? idx : -1))
    .filter(idx => idx !== -1);
  const firstPlayerIndex =
    preferredIndices.length > 0
      ? preferredIndices[Math.floor(Math.random() * preferredIndices.length)]
      : undefined;

  const unlimitedTime = !!waitingRoom.unlimitedTime;
  waitingRoom.players = [];
  waitingRoom.unlimitedTime = false;

  const gameState = createInitialGameState(roomPlayers, {
    firstPlayerIndex,
    unlimitedTime,
  });

  const room = {
    id: roomId,
    players: roomPlayers,
    state: gameState,
    createdAt: now,
    lastPlayerAction: now,
    ratingsCommitted: false,
    trickResolveTimer: null,
  };
  gameRooms.set(roomId, room);
  replaySafe(() => replayRecorder.begin(room));

  for (let i = 0; i < roomPlayers.length; i++) {
    const rp = roomPlayers[i];
    const sock = io.sockets.sockets.get(rp.socketId);
    if (sock) sock.join(roomId);
    io.to(rp.socketId).emit('game_start', {
      roomId,
      seatIndex: i,
      playerIndex: i,
      state: viewFor(room, i),
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Socket.IO connection handling
// ═══════════════════════════════════════════════════════════

const socketUsers = new Map();

// Handlers get a plain-object payload and a callable ack whatever the client
// sent, and a throw or rejection is logged instead of crashing the process
// (which would drop every table at once).
function handle(socket, event, handler) {
  socket.on(event, (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
    const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
    Promise.resolve()
      .then(() => handler(payload, ack))
      .catch(err => console.error(`[socket] ${event} failed:`, err));
  });
}

io.on('connection', socket => {
  handle(socket, 'login', async ({ username }, ack) => {
    await accountStore.ready;
    const acct = typeof username === 'string' ? accounts[username] : null;
    if (!acct) return ack({ error: 'Account not found' });
    socketUsers.set(socket.id, acct.username);
    ack({ ok: true, success: true, account: acct, inGame: !!findActiveGame(acct.username) });
  });

  handle(socket, 'enter_lobby', (_payload, ack) => {
    const username = socketUsers.get(socket.id);
    if (!username) return ack({ action: 'error', error: 'Login required' });
    const acct = accounts[username];
    if (!acct) return ack({ action: 'error', error: 'Account not found' });

    // Seamless Reconnect if user is in an active game
    const active = findActiveGame(username);
    if (active) {
      const { roomId, room, seat } = active;
      const now = Date.now();
      const rp = room.players[seat];
      const wasDisconnected = !rp.connected;
      rp.socketId = socket.id;
      rp.connected = true;
      rp.disconnectedAt = null;
      room.lastPlayerAction = now;
      if (wasDisconnected && room.state.currentPlayerIndex === seat) {
        startTurnTimeControl(room.state, now, false);
      }
      socket.join(roomId);

      socket.emit('game_start', {
        roomId,
        seatIndex: seat,
        playerIndex: seat,
        state: viewFor(room, seat),
        isReconnect: true,
      });

      emitGameStateToRoom(room, 'game_state_update', {});
      if (wasDisconnected) {
        socket.to(roomId).emit('player_reconnected', { username, seatIndex: seat });
      }
      return ack({ action: 'rejoin_game' });
    }

    // Normal lobby entry (max 4 players)
    waitingRoom.players = waitingRoom.players.filter(p => p.username !== username);
    if (waitingRoom.players.length >= 4) {
      socket.emit('action_error', { message: 'Lobby is full (4/4 players)' });
      return ack({ action: 'lobby_full', error: 'Lobby is full (4/4 players)' });
    }

    waitingRoom.players.push({
      socketId: socket.id,
      username: acct.username,
      avatarSeed: acct.avatarSeed,
      ready: false,
      wantsFirst: false,
    });
    broadcastLobby();
    ack({ action: 'lobby', lobbyState: lobbySnapshot() });
  });

  handle(socket, 'toggle_ready', () => {
    const p = waitingRoom.players.find(x => x.socketId === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    broadcastLobby();
    checkGameStart();
  });

  handle(socket, 'toggle_wants_first', (_payload, ack) => {
    const p = waitingRoom.players.find(x => x.socketId === socket.id);
    if (!p) return ack({ error: 'Not in lobby' });
    p.wantsFirst = !p.wantsFirst;
    broadcastLobby();
    ack({ ok: true });
  });

  handle(socket, 'toggle_unlimited_time', (_payload, ack) => {
    const p = waitingRoom.players.find(x => x.socketId === socket.id);
    if (!p) return ack({ error: 'Not in lobby' });
    waitingRoom.unlimitedTime = !waitingRoom.unlimitedTime;
    waitingRoom.players.forEach(player => {
      player.ready = false;
    });
    broadcastLobby();
    ack({ ok: true });
  });

  handle(socket, 'leave_lobby', () => {
    removeFromLobby(socket.id);
  });

  handle(socket, 'return_to_lobby', ({ roomId }, ack) => {
    if (typeof roomId === 'string') socket.leave(roomId);
    ack({ ok: true });
  });

  // ── Game actions (Bidding, Calling Partner, Playing Cards) ──
  handle(socket, 'game_action', ({ roomId, action }, ack) => {
    const room = gameRooms.get(roomId);
    if (!room) {
      ack({ error: 'Room not found' });
      return;
    }
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx === -1) {
      ack({ error: 'Not in room' });
      return;
    }

    const now = Date.now();
    room.lastPlayerAction = now;
    const clockStatus = updateTimeControl(room.state, now);
    if (clockStatus.expired) {
      forfeitOnTimeout(room, room.state.currentPlayerIndex);
      ack({ error: 'Active player ran out of time' });
      return;
    }

    const actingIndex = room.state.currentPlayerIndex;
    if (actingIndex === playerIdx) {
      consumeTurnTime(room.state, actingIndex, now);
    }

    const res = processAction(room.state, playerIdx, action);
    if (res.error) {
      if (actingIndex === playerIdx && !room.state.trickPendingResolve) {
        startTurnTimeControl(room.state, now, false);
      }
      socket.emit('action_error', { message: res.error });
      ack({ error: res.error });
      return;
    }

    replaySafe(() => replayRecorder.onActionResult(room, res.result));

    if (res.completed) {
      addTimeIncrement(room.state, actingIndex, now);
      if (res.trickComplete) {
        scheduleTrickResolve(room);
      } else {
        const nextPlayer = room.players[room.state.currentPlayerIndex];
        startTurnTimeControl(room.state, now, !nextPlayer?.connected);
      }
    }

    if (room.state.phase === 'GAME_OVER') {
      finalizeFinishedGame(room);
    }

    emitGameStateToRoom(room, 'game_state_update', {
      lastAction: res.result,
    });
    ack({ ok: true });
  });

  // ── Resign (Forfeit) ──
  handle(socket, 'resign_game', ({ roomId }) => {
    const room = gameRooms.get(roomId);
    if (!room) return;
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx === -1) return;

    const now = Date.now();
    room.lastPlayerAction = now;
    if (room.state.currentPlayerIndex === playerIdx) {
      consumeTurnTime(room.state, playerIdx, now);
    }
    if (room.trickResolveTimer) {
      clearTimeout(room.trickResolveTimer);
      room.trickResolveTimer = null;
    }
    processResign(room.state, playerIdx, 'FORFEIT');
    replaySafe(() => replayRecorder.onResign(room, playerIdx));
    finalizeFinishedGame(room);

    emitGameStateToRoom(room, 'game_state_update', {
      lastAction: { type: 'RESIGN', actingPlayer: playerIdx, payload: {} },
    });
  });

  // ── Quit Room (Return everyone to lobby) ──
  handle(socket, 'quit_room', ({ roomId }) => {
    const room = gameRooms.get(roomId);
    if (!room) return;
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx === -1) return;

    const quitterName = room.players[playerIdx].username;
    if (room.trickResolveTimer) {
      clearTimeout(room.trickResolveTimer);
      room.trickResolveTimer = null;
    }

    for (const p of room.players) {
      if (p.socketId) {
        io.to(p.socketId).emit('room_closed', { reason: `${quitterName} left the room` });
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.leave(roomId);
      }
    }
    replaySafe(() => replayRecorder.discard(room));
    gameRooms.delete(roomId);
  });

  // ── Liveness probe (clients ask when they come back from the background) ──
  handle(socket, 'ping_check', (_payload, ack) => {
    ack({ ok: true });
  });

  // ── Disconnect ──
  handle(socket, 'disconnect', () => {
    const username = socketUsers.get(socket.id);
    socketUsers.delete(socket.id);
    removeFromLobby(socket.id);
    if (!username) return;

    for (const [roomId, room] of gameRooms) {
      if (room.state.phase === 'GAME_OVER') continue;
      const seat = room.players.findIndex(
        p => p.username === username && p.socketId === socket.id,
      );
      if (seat === -1) continue;
      const now = Date.now();
      room.players[seat].connected = false;
      room.players[seat].disconnectedAt = now;
      pauseTurnTimeControl(room.state, seat, now);
      emitGameStateToRoom(room, 'game_state_update', {});
      socket.to(roomId).emit('player_disconnected', { username, seatIndex: seat });
      break;
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Periodic room cleanup & clock expiration monitor
// ═══════════════════════════════════════════════════════════

const ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of gameRooms) {
    if (room.state.phase === 'GAME_OVER' && now - room.createdAt > 5 * 60 * 1000) {
      replaySafe(() => replayRecorder.discard(room));
      gameRooms.delete(roomId);
      continue;
    }
    if (now - room.createdAt > ROOM_MAX_AGE_MS) {
      for (const p of room.players) {
        if (p.socketId) {
          io.to(p.socketId).emit('room_closed', { reason: 'Game timed out (max duration reached)' });
        }
      }
      replaySafe(() => replayRecorder.discard(room));
      gameRooms.delete(roomId);
      continue;
    }
    if (room.state.phase !== 'GAME_OVER' && now - room.lastPlayerAction > INACTIVITY_TIMEOUT_MS) {
      for (const p of room.players) {
        if (p.socketId) {
          io.to(p.socketId).emit('room_closed', { reason: 'Room closed due to 10 minutes of inactivity' });
        }
      }
      replaySafe(() => replayRecorder.discard(room));
      gameRooms.delete(roomId);
    }
  }
}, 60 * 1000);

// The seat that has been gone longest past the grace period, or -1. Only while
// someone is still at the table: a table everyone left just expires.
function expiredDisconnect(room, now) {
  if (!room.players.some(p => p.connected)) return -1;
  let seat = -1;
  room.players.forEach((p, idx) => {
    if (p.connected || !p.disconnectedAt || now - p.disconnectedAt < DISCONNECT_GRACE_MS) return;
    if (seat === -1 || p.disconnectedAt < room.players[seat].disconnectedAt) seat = idx;
  });
  return seat;
}

setInterval(() => {
  const now = Date.now();
  for (const [, room] of gameRooms) {
    if (room.state.phase === 'GAME_OVER') continue;
    try {
      if (room.state.timeControl && updateTimeControl(room.state, now).expired) {
        forfeitOnTimeout(room, room.state.currentPlayerIndex);
        continue;
      }
      const gone = expiredDisconnect(room, now);
      if (gone !== -1) forfeitOnTimeout(room, gone);
    } catch (err) {
      console.error(`[room ${room.id}] tick failed:`, err);
    }
  }
}, 250);

// ═══════════════════════════════════════════════════════════
// Start standalone server (Render) or export for Vite dev server
// ═══════════════════════════════════════════════════════════

if (require.main === module) {
  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log(`Singaporean Bridge Server listening on port ${PORT}`);

    // Self-ping keeps a free Render instance awake. Set KEEP_AWAKE=0 to let it
    // sleep when idle (saves free instance hours; first visit then waits ~1 min).
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL && process.env.KEEP_AWAKE !== '0') {
      setInterval(() => {
        fetch(`${RENDER_URL}/health`).catch(() => {});
      }, 5 * 60 * 1000);
    }
  });
}

module.exports = { app, server, io };
