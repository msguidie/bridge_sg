// ═══════════════════════════════════════════════════════════
// Replay recorder for Singaporean Bridge
// Captures initial 4 hands and compact action stream.
// Guarded so a recorder failure can never affect live gameplay.
// ═══════════════════════════════════════════════════════════

const replayStore = require('./replayStore');

const recordings = new Map();
const MAX_ACTIVE_RECORDINGS = 200;

function guard(name, fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.error(`[replay] ${name} failed: ${err?.message || err}`);
    return fallback;
  }
}

function trimActiveRecordings() {
  while (recordings.size > MAX_ACTIVE_RECORDINGS) {
    const oldest = recordings.keys().next();
    if (oldest.done) return;
    recordings.delete(oldest.value);
  }
}

function begin(room) {
  return guard('begin', () => {
    if (!room || !room.id || !room.state) return null;
    const state = room.state;

    const recording = {
      v: 1,
      id: room.id,
      t: room.createdAt || Date.now(),
      e: null,
      clock: !!state.timeControl,
      players: state.players.map(p => ({
        u: p.username,
        a: p.avatarSeed ?? 1,
      })),
      first: state.firstBidderIndex ?? state.currentPlayerIndex,
      setup: {
        hands: state.players.map(p => p.hand.map(c => c.id)),
      },
      actions: [],
    };

    recordings.set(room.id, recording);
    trimActiveRecordings();
    return recording;
  });
}

function compactFromActionResult(actionResult) {
  if (!actionResult || typeof actionResult.type !== 'string') return null;
  const actor = actionResult.actingPlayer;
  if (!Number.isInteger(actor)) return null;
  const pl = actionResult.payload || {};

  switch (actionResult.type) {
    case 'BID':
      return [actor, 'B', pl.level, pl.strain];
    case 'PASS':
      return [actor, 'P'];
    case 'CALL_CARD':
      return [actor, 'C', pl.calledCard.suit, pl.calledCard.rank];
    case 'PLAY_CARD':
      return [actor, 'PLAY', pl.card.id];
    default:
      return null;
  }
}

function onActionResult(room, actionResult) {
  return guard('onActionResult', () => {
    const rec = room && recordings.get(room.id);
    if (!rec) return null;
    const entry = compactFromActionResult(actionResult);
    if (!entry) return null;
    rec.actions.push(entry);
    return entry;
  });
}

function onResign(room, playerIndex) {
  return guard('onResign', () => {
    const rec = room && recordings.get(room.id);
    if (!rec || !Number.isInteger(playerIndex)) return null;
    const entry = [playerIndex, 'X'];
    rec.actions.push(entry);
    return entry;
  });
}

function onTimeout(room, playerIndex) {
  return guard('onTimeout', () => {
    const rec = room && recordings.get(room.id);
    if (!rec || !Number.isInteger(playerIndex)) return null;
    const entry = [playerIndex, 'T'];
    rec.actions.push(entry);
    return entry;
  });
}

function finish(room) {
  return guard('finish', () => {
    const rec = room && recordings.get(room.id);
    if (!rec) return null;
    recordings.delete(room.id);

    const state = room.state;
    const gr = state.gameResult || {};
    const ratingChanges = gr.ratingChanges || [0, 0, 0, 0];
    const winners = ratingChanges
      .map((delta, idx) => (delta > 0 ? idx : -1))
      .filter(idx => idx !== -1);

    const roles = state.players.map((_, idx) => {
      if (state.declarerIndex === null) return null;
      if (idx === state.declarerIndex) return 'LORD';
      if (state.partnerIndex !== null && idx === state.partnerIndex) return 'LOYALIST';
      if (state.partnerIndex !== null) return 'REBEL';
      return null;
    });

    rec.e = Date.now();
    rec.result = {
      winnerSide: gr.winnerSide || null,
      reason: gr.reason || null,
      lordTricks: gr.lordTricks ?? 0,
      rebelTricks: gr.rebelTricks ?? 0,
      tricks: state.players.map(p => p.tricksWon),
      roles,
      winners,
      ratingChanges,
      contract: state.contract ? { ...state.contract } : null,
      calledCard: state.calledCard ? { ...state.calledCard } : null,
    };

    replayStore.add(rec);
    return rec;
  });
}

function discard(room) {
  return guard('discard', () => {
    if (!room || !room.id) return false;
    return recordings.delete(room.id);
  });
}

module.exports = {
  begin,
  onActionResult,
  onResign,
  onTimeout,
  finish,
  discard,
  compactFromActionResult,
};
