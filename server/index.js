const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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

// ═══════════════════════════════════════════════════════════
// Accounts persistence (Initial rating = 0, wins +1 / losses -1)
// ═══════════════════════════════════════════════════════════

const DATA_FILE = path.join(__dirname, 'data', 'accounts.json');

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadAccounts() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAccounts(accounts) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
}

let accounts = loadAccounts();

app.get('/api/accounts', (_req, res) => {
  res.json(
    Object.values(accounts).sort((a, b) => (b.rating || 0) - (a.rating || 0)),
  );
});

app.post('/api/accounts', (req, res) => {
  const { username } = req.body;
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
  saveAccounts(accounts);
  res.status(201).json(acct);
});

app.delete('/api/accounts/:username', (req, res) => {
  const { username } = req.params;
  if (!accounts[username]) {
    return res.status(404).json({ error: 'Account not found' });
  }
  delete accounts[username];
  saveAccounts(accounts);
  res.json({ ok: true });
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

function broadcastLobby() {
  const payload = {
    players: waitingRoom.players.map(p => ({
      username: p.username,
      avatarSeed: p.avatarSeed,
      ready: p.ready,
      wantsFirst: !!p.wantsFirst,
    })),
    unlimitedTime: !!waitingRoom.unlimitedTime,
  };
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

function emitGameStateToRoom(room, eventName = 'game_state_update', extraPayload = {}) {
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!p.socketId) continue;
    io.to(p.socketId).emit(eventName, {
      ...extraPayload,
      state: clientViewForPlayer(room.state, i),
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
  saveAccounts(accounts);
  replaySafe(() => replayRecorder.finish(room));
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
      state: clientViewForPlayer(gameState, i),
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Socket.IO connection handling
// ═══════════════════════════════════════════════════════════

const socketUsers = new Map();

io.on('connection', socket => {
  socket.on('login', ({ username } = {}, cb) => {
    const acct = accounts[username];
    if (!acct) return cb?.({ error: 'Account not found' });
    socketUsers.set(socket.id, username);
    cb?.({ ok: true, success: true, account: acct });
  });

  socket.on('enter_lobby', cb => {
    const username = socketUsers.get(socket.id);
    if (!username) {
      cb?.({ action: 'error', error: 'Login required' });
      return;
    }
    const acct = accounts[username];
    if (!acct) {
      cb?.({ action: 'error', error: 'Account not found' });
      return;
    }

    // Seamless Reconnect if user is in an active game
    const active = findActiveGame(username);
    if (active) {
      const { roomId, room, seat } = active;
      const now = Date.now();
      const wasDisconnected = !room.players[seat].connected;
      room.players[seat].socketId = socket.id;
      room.players[seat].connected = true;
      room.lastPlayerAction = now;
      if (wasDisconnected && room.state.phase !== 'GAME_OVER' && room.state.timeControl) {
        addTimeIncrement(room.state, seat, now);
        if (room.state.currentPlayerIndex === seat) {
          startTurnTimeControl(room.state, now, false);
        }
      }
      socket.join(roomId);

      socket.emit('game_start', {
        roomId,
        seatIndex: seat,
        playerIndex: seat,
        state: clientViewForPlayer(room.state, seat),
        isReconnect: true,
      });

      emitGameStateToRoom(room, 'game_state_update', {});
      socket.to(roomId).emit('player_reconnected', { username, seatIndex: seat });
      cb?.({ action: 'rejoin_game' });
      return;
    }

    // Normal lobby entry (max 4 players)
    waitingRoom.players = waitingRoom.players.filter(p => p.username !== username);
    if (waitingRoom.players.length >= 4) {
      socket.emit('action_error', { message: 'Lobby is full (4/4 players)' });
      cb?.({ action: 'lobby_full', error: 'Lobby is full (4/4 players)' });
      return;
    }

    waitingRoom.players.push({
      socketId: socket.id,
      username: acct.username,
      avatarSeed: acct.avatarSeed,
      ready: false,
      wantsFirst: false,
    });
    broadcastLobby();
    cb?.({
      action: 'lobby',
      lobbyState: {
        players: waitingRoom.players.map(p => ({
          username: p.username,
          avatarSeed: p.avatarSeed,
          ready: p.ready,
          wantsFirst: !!p.wantsFirst,
        })),
        unlimitedTime: !!waitingRoom.unlimitedTime,
      },
    });
  });

  socket.on('toggle_ready', () => {
    const p = waitingRoom.players.find(x => x.socketId === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    broadcastLobby();
    checkGameStart();
  });

  socket.on('toggle_wants_first', cb => {
    const p = waitingRoom.players.find(x => x.socketId === socket.id);
    if (!p) return cb?.({ error: 'Not in lobby' });
    p.wantsFirst = !p.wantsFirst;
    broadcastLobby();
    cb?.({ ok: true });
  });

  socket.on('toggle_unlimited_time', cb => {
    const p = waitingRoom.players.find(x => x.socketId === socket.id);
    if (!p) return cb?.({ error: 'Not in lobby' });
    waitingRoom.unlimitedTime = !waitingRoom.unlimitedTime;
    waitingRoom.players.forEach(player => {
      player.ready = false;
    });
    broadcastLobby();
    cb?.({ ok: true });
  });

  socket.on('leave_lobby', () => {
    removeFromLobby(socket.id);
  });

  socket.on('return_to_lobby', ({ roomId } = {}, cb) => {
    if (roomId) socket.leave(roomId);
    cb?.({ ok: true });
  });

  // ── Game actions (Bidding, Calling Partner, Playing Cards) ──
  socket.on('game_action', ({ roomId, action } = {}, ack) => {
    const room = gameRooms.get(roomId);
    if (!room) {
      ack?.({ error: 'Room not found' });
      return;
    }
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx === -1) {
      ack?.({ error: 'Not in room' });
      return;
    }

    const now = Date.now();
    room.lastPlayerAction = now;
    const clockStatus = updateTimeControl(room.state, now);
    if (clockStatus.expired) {
      const timedOutIndex = room.state.currentPlayerIndex;
      processResign(room.state, timedOutIndex, 'TIMEOUT');
      replaySafe(() => replayRecorder.onTimeout(room, timedOutIndex));
      finalizeFinishedGame(room);
      emitGameStateToRoom(room, 'game_state_update', {
        lastAction: { type: 'TIMEOUT', actingPlayer: timedOutIndex, payload: {} },
      });
      ack?.({ error: 'Active player ran out of time' });
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
      ack?.({ error: res.error });
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
    ack?.({ ok: true });
  });

  // ── Resign (Forfeit) ──
  socket.on('resign_game', ({ roomId }) => {
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
  socket.on('quit_room', ({ roomId }) => {
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

  // ── Keep-alive ping ──
  socket.on('ping_keep_alive', () => {
    socket.emit('pong_keep_alive');
    const username = socketUsers.get(socket.id);
    if (username) {
      const active = findActiveGame(username);
      if (active) active.room.lastPlayerAction = Date.now();
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const username = socketUsers.get(socket.id);
    socketUsers.delete(socket.id);
    removeFromLobby(socket.id);

    if (username) {
      for (const [roomId, room] of gameRooms) {
        const seat = room.players.findIndex(
          p => p.username === username && p.socketId === socket.id,
        );
        if (seat !== -1) {
          const now = Date.now();
          room.players[seat].connected = false;
          pauseTurnTimeControl(room.state, seat, now);
          emitGameStateToRoom(room, 'game_state_update', {});
          socket.to(roomId).emit('player_disconnected', { username, seatIndex: seat });
          break;
        }
      }
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

setInterval(() => {
  const now = Date.now();
  for (const [, room] of gameRooms) {
    if (room.state.phase === 'GAME_OVER' || !room.state.timeControl) continue;
    const status = updateTimeControl(room.state, now);
    if (!status.expired) continue;

    const timedOutIndex = room.state.currentPlayerIndex;
    if (room.trickResolveTimer) {
      clearTimeout(room.trickResolveTimer);
      room.trickResolveTimer = null;
    }
    processResign(room.state, timedOutIndex, 'TIMEOUT');
    replaySafe(() => replayRecorder.onTimeout(room, timedOutIndex));
    finalizeFinishedGame(room);

    emitGameStateToRoom(room, 'game_state_update', {
      lastAction: { type: 'TIMEOUT', actingPlayer: timedOutIndex, payload: {} },
    });
  }
}, 250);

// ═══════════════════════════════════════════════════════════
// Start standalone server (Render) or export for Vite dev server
// ═══════════════════════════════════════════════════════════

if (require.main === module) {
  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log(`Singaporean Bridge Server listening on port ${PORT}`);

    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
      setInterval(() => {
        fetch(`${RENDER_URL}/health`).catch(() => {});
      }, 5 * 60 * 1000);
    }
  });
}

module.exports = { app, server, io };
