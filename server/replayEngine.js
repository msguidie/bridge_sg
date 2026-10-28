// ═══════════════════════════════════════════════════════════
// Replay reconstruction engine for Singaporean Bridge
// Replays a stored compact replay JSON through the exact same gameLogic.js
// functions so replay frames never drift from live game rules.
// ═══════════════════════════════════════════════════════════

const {
  cardFromId,
  sortHand,
  createInitialGameState,
  processAction,
  resolvePendingTrick,
  processResign,
} = require('./gameLogic');

class ReplayCorruptError extends Error {
  constructor(actionIndex, message) {
    super(message);
    this.name = 'ReplayCorruptError';
    this.actionIndex = actionIndex;
  }
}

function deepClone(val) {
  return JSON.parse(JSON.stringify(val));
}

function getRole(state, idx) {
  if (state.declarerIndex === null) return null;
  if (idx === state.declarerIndex) return 'LORD';
  if (state.partnerIndex !== null && idx === state.partnerIndex) return 'LOYALIST';
  if (state.partnerIndex !== null) return 'REBEL';
  return null;
}

// Snapshot for replay viewer: all 4 hands and roles are included so the viewer
// can switch perspectives or toggle all-hands view client-side.
function replayStateView(state) {
  return {
    phase: state.phase,
    numPlayers: state.numPlayers,
    currentPlayerIndex: state.currentPlayerIndex,
    firstBidderIndex: state.firstBidderIndex,
    highestBid: deepClone(state.highestBid),
    consecutivePasses: state.consecutivePasses,
    bidHistory: deepClone(state.bidHistory),
    declarerIndex: state.declarerIndex,
    partnerIndex: state.partnerIndex,
    contract: deepClone(state.contract),
    calledCard: deepClone(state.calledCard),
    trumpBroken: state.trumpBroken,
    trickNumber: state.trickNumber,
    currentTrick: deepClone(state.currentTrick),
    trickPendingResolve: deepClone(state.trickPendingResolve),
    lastCompletedTrick: deepClone(state.lastCompletedTrick),
    turnNumber: state.turnNumber,
    resignedPlayers: [...state.resignedPlayers],
    gameResult: deepClone(state.gameResult),
    legalCardIds: [],
    players: state.players.map((p, idx) => ({
      username: p.username,
      avatarSeed: p.avatarSeed,
      hand: deepClone(p.hand),
      handCount: p.hand.length,
      tricksWon: p.tricksWon,
      role: getRole(state, idx),
    })),
    timeControl: null,
  };
}

// Compact action codes:
// [actor, 'B', level, strain]  -> BID
// [actor, 'P']                 -> PASS
// [actor, 'C', suit, rank]     -> CALL_CARD
// [actor, 'PLAY', cardId]      -> PLAY_CARD
// [actor, 'X']                 -> RESIGN
// [actor, 'T']                 -> TIMEOUT
function compactToProtocol(entry) {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const actor = entry[0];
  const code = entry[1];
  if (!Number.isInteger(actor) || actor < 0 || actor > 3) return null;

  switch (code) {
    case 'B':
      return { actor, kind: 'ACTION', action: { type: 'BID', level: entry[2], strain: entry[3] } };
    case 'P':
      return { actor, kind: 'ACTION', action: { type: 'PASS' } };
    case 'C':
      return { actor, kind: 'ACTION', action: { type: 'CALL_CARD', suit: entry[2], rank: entry[3] } };
    case 'PLAY':
      return { actor, kind: 'ACTION', action: { type: 'PLAY_CARD', cardId: entry[2] } };
    case 'X':
      return { actor, kind: 'RESIGN' };
    case 'T':
      return { actor, kind: 'TIMEOUT' };
    default:
      return null;
  }
}

function buildInitialState(json) {
  if (!json || typeof json !== 'object') {
    throw new ReplayCorruptError(-1, 'Replay is not an object');
  }
  if (!Array.isArray(json.players) || json.players.length !== 4) {
    throw new ReplayCorruptError(-1, 'Replay must have 4 players');
  }
  if (!json.setup || !Array.isArray(json.setup.hands) || json.setup.hands.length !== 4) {
    throw new ReplayCorruptError(-1, 'Replay setup hands missing');
  }

  const players = json.players.map(p => ({
    username: p.u,
    avatarSeed: p.a ?? 1,
  }));

  const state = createInitialGameState(players, {
    firstPlayerIndex: json.first ?? 0,
    unlimitedTime: true,
  });

  for (let i = 0; i < 4; i++) {
    const handIds = json.setup.hands[i];
    if (!Array.isArray(handIds) || handIds.length !== 13) {
      throw new ReplayCorruptError(-1, `Invalid hand for seat ${i}`);
    }
    const cards = handIds.map(id => {
      const c = cardFromId(id);
      if (!c) throw new ReplayCorruptError(-1, `Invalid card id ${id}`);
      return c;
    });
    state.players[i].hand = sortHand(cards);
  }

  state.currentPlayerIndex = json.first ?? 0;
  state.firstBidderIndex = json.first ?? 0;
  state.timeControl = null;
  return state;
}

function reconstruct(replayJson) {
  const state = buildInitialState(replayJson);
  const meta = {
    t: replayJson.t ?? null,
    e: replayJson.e ?? null,
    clock: replayJson.clock === true,
    first: replayJson.first ?? 0,
    players: replayJson.players.map(p => ({
      username: p.u,
      avatarSeed: p.a ?? 1,
    })),
    result: replayJson.result ? deepClone(replayJson.result) : null,
  };

  const frames = [
    {
      i: 0,
      actor: null,
      action: null,
      result: null,
      state: replayStateView(state),
    },
  ];

  const actions = Array.isArray(replayJson.actions) ? replayJson.actions : [];
  actions.forEach((compact, actionIdx) => {
    const plan = compactToProtocol(compact);
    if (!plan) {
      throw new ReplayCorruptError(actionIdx, `Malformed action ${JSON.stringify(compact)}`);
    }

    if (plan.kind === 'RESIGN' || plan.kind === 'TIMEOUT') {
      processResign(state, plan.actor, plan.kind === 'TIMEOUT' ? 'TIMEOUT' : 'FORFEIT');
      frames.push({
        i: frames.length,
        actor: plan.actor,
        action: deepClone(compact),
        result: {
          type: plan.kind,
          actingPlayer: plan.actor,
          payload: {},
        },
        state: replayStateView(state),
      });
      return;
    }

    const stepRes = processAction(state, plan.actor, plan.action);
    if (stepRes.error) {
      throw new ReplayCorruptError(actionIdx, `${plan.action.type} rejected: ${stepRes.error}`);
    }

    // Push frame showing the action (including the 4th card on the table with winning glow!)
    frames.push({
      i: frames.length,
      actor: plan.actor,
      action: deepClone(compact),
      result: deepClone(stepRes.result),
      state: replayStateView(state),
    });

    // If a trick just completed (4th card played), resolve the pending trick into the next frame
    // unless that trick resolution immediately ended the game, in which case we update or append
    if (stepRes.trickComplete && state.trickPendingResolve) {
      const winnerIdx = state.trickPendingResolve.winnerIndex;
      const resolved = resolvePendingTrick(state);
      frames.push({
        i: frames.length,
        actor: winnerIdx,
        action: [winnerIdx, 'TRICK_WIN'],
        result: {
          type: 'TRICK_RESOLVED',
          actingPlayer: winnerIdx,
          payload: { winnerIndex: winnerIdx, gameOver: resolved?.gameOver },
        },
        state: replayStateView(state),
      });
    }
  });

  return { meta, frames };
}

module.exports = {
  reconstruct,
  buildInitialState,
  ReplayCorruptError,
};
