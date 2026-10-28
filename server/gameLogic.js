// ═══════════════════════════════════════════════════════════
// Server-side game logic — Singaporean Bridge (Floating Bridge)
// Single source of truth for bidding, partner calling, trick-taking, and clocks
// ═══════════════════════════════════════════════════════════

// Suits: 0 = Clubs (♣), 1 = Diamonds (♦), 2 = Hearts (♥), 3 = Spades (♠), 4 = No Trump (NT, bidding only)
const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠', 'NT'];
const SUIT_NAMES = ['Clubs', 'Diamonds', 'Hearts', 'Spades', 'No Trump'];

// Display sort order for hand: Spades (black), Hearts (red), Clubs (black), Diamonds (red)
const HAND_SUIT_ORDER = { 3: 0, 2: 1, 0: 2, 1: 3 };

function makeCard(suit, rank) {
  return {
    id: suit * 13 + (rank - 2),
    suit,
    rank,
  };
}

function cardFromId(id) {
  if (!Number.isInteger(id) || id < 0 || id >= 52) return null;
  const suit = Math.floor(id / 13);
  const rank = (id % 13) + 2;
  return { id, suit, rank };
}

function buildDeck() {
  const deck = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push(makeCard(suit, rank));
    }
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortHand(cards) {
  return [...cards].sort((a, b) => {
    const sa = HAND_SUIT_ORDER[a.suit] ?? a.suit;
    const sb = HAND_SUIT_ORDER[b.suit] ?? b.suit;
    if (sa !== sb) return sa - sb;
    return b.rank - a.rank;
  });
}

function isHigherBid(level, strain, currentHighest) {
  if (!currentHighest) return true;
  if (level > currentHighest.level) return true;
  if (level === currentHighest.level && strain > currentHighest.strain) return true;
  return false;
}

function getRoleForSeat(state, seatIndex) {
  if (state.declarerIndex === null) return null;
  if (seatIndex === state.declarerIndex) return 'LORD';
  if (state.partnerIndex !== null && seatIndex === state.partnerIndex) return 'LOYALIST';
  if (state.partnerIndex !== null) return 'REBEL';
  return null;
}

function calculateRatingChanges(state) {
  const n = state.numPlayers || 4;
  if (!state.gameResult) return new Array(n).fill(0);

  const { winnerSide, forfeitingPlayerIndex } = state.gameResult;

  if (state.partnerIndex === null && Number.isInteger(forfeitingPlayerIndex)) {
    return state.players.map((_, idx) => (idx === forfeitingPlayerIndex ? -1 : 1));
  }

  return state.players.map((_, idx) => {
    const isLordSide = idx === state.declarerIndex || idx === state.partnerIndex;
    if (winnerSide === 'LORD_WIN') {
      return isLordSide ? 1 : -1;
    }
    return isLordSide ? -1 : 1;
  });
}

// ── Create initial game state ──

function createInitialGameState(players, options = {}) {
  const n = 4;
  const deck = shuffle(buildDeck());

  const gamePlayers = players.slice(0, 4).map((p, idx) => ({
    username: p.username,
    avatarSeed: p.avatarSeed ?? idx + 1,
    hand: sortHand(deck.slice(idx * 13, (idx + 1) * 13)),
    tricksWon: 0,
  }));

  const preferredFirst =
    Number.isInteger(options.firstPlayerIndex) &&
    options.firstPlayerIndex >= 0 &&
    options.firstPlayerIndex < n
      ? options.firstPlayerIndex
      : Math.floor(Math.random() * n);

  const now = Date.now();
  const mainTimeMs = 90 * 1000; // 1.5 minutes base time
  const incrementMs = 10 * 1000; // +10 seconds per action

  return {
    phase: 'BIDDING', // 'BIDDING' | 'CALL_PARTNER' | 'PLAYING' | 'GAME_OVER'
    players: gamePlayers,
    numPlayers: n,
    currentPlayerIndex: preferredFirst,
    firstBidderIndex: preferredFirst,
    highestBid: null, // { level, strain, bidderIndex }
    consecutivePasses: 0,
    bidHistory: [], // [{ playerIndex, type: 'BID' | 'PASS', level?, strain? }]
    declarerIndex: null,
    partnerIndex: null, // Server-secret until GAME_OVER
    contract: null, // { level, strain, declarerIndex, lordTarget, rebelTarget }
    calledCard: null, // { id, suit, rank }
    trumpBroken: false,
    trickNumber: 1,
    currentTrick: {
      leaderIndex: null,
      leadSuit: null,
      cards: [], // [{ playerIndex, card }]
    },
    trickPendingResolve: null, // { winnerIndex, winningCardId, resolveAt }
    lastCompletedTrick: null,
    turnNumber: 0,
    resignedPlayers: [],
    gameResult: null,
    timeControl: !options.unlimitedTime
      ? {
          mainTimeMs,
          incrementMs,
          playerTimeRemainingMs: new Array(n).fill(mainTimeMs),
          activeSince: now,
          serverNow: now,
        }
      : null,
  };
}

// ── Legal card calculation ──

function getLegalCardIds(state, playerIndex) {
  if (state.phase !== 'PLAYING') return [];
  if (state.trickPendingResolve) return [];
  if (state.currentPlayerIndex !== playerIndex) return [];

  const player = state.players[playerIndex];
  if (!player || !player.hand.length) return [];

  const hand = player.hand;
  const trickCards = state.currentTrick.cards;
  const trumpSuit = state.contract && state.contract.strain < 4 ? state.contract.strain : null;

  // Leading the trick
  if (trickCards.length === 0) {
    if (trumpSuit !== null && !state.trumpBroken) {
      const nonTrumps = hand.filter(c => c.suit !== trumpSuit);
      if (nonTrumps.length > 0) {
        return nonTrumps.map(c => c.id);
      }
    }
    return hand.map(c => c.id);
  }

  // Following suit
  const leadSuit = state.currentTrick.leadSuit;
  const sameSuit = hand.filter(c => c.suit === leadSuit);
  if (sameSuit.length > 0) {
    return sameSuit.map(c => c.id);
  }
  return hand.map(c => c.id);
}

// ── Client view filtering (hides secret partner and other players' hands) ──

function clientViewForPlayer(state, viewerIndex) {
  const isGameOver = state.phase === 'GAME_OVER';
  const legalCardIds = getLegalCardIds(state, viewerIndex);

  return {
    phase: state.phase,
    numPlayers: state.numPlayers,
    currentPlayerIndex: state.currentPlayerIndex,
    firstBidderIndex: state.firstBidderIndex,
    highestBid: state.highestBid,
    consecutivePasses: state.consecutivePasses,
    bidHistory: state.bidHistory,
    declarerIndex: state.declarerIndex,
    partnerIndex: isGameOver ? state.partnerIndex : null,
    contract: state.contract,
    calledCard: state.calledCard,
    trumpBroken: state.trumpBroken,
    trickNumber: state.trickNumber,
    currentTrick: state.currentTrick,
    trickPendingResolve: state.trickPendingResolve,
    lastCompletedTrick: state.lastCompletedTrick,
    turnNumber: state.turnNumber,
    resignedPlayers: state.resignedPlayers,
    gameResult: state.gameResult,
    legalCardIds,
    players: state.players.map((p, idx) => ({
      username: p.username,
      avatarSeed: p.avatarSeed,
      hand: idx === viewerIndex ? p.hand : [],
      handCount: p.hand.length,
      tricksWon: p.tricksWon,
      role: isGameOver ? getRoleForSeat(state, idx) : idx === state.declarerIndex ? 'LORD' : null,
    })),
    timeControl: state.timeControl
      ? { ...state.timeControl, serverNow: Date.now() }
      : null,
  };
}

// ── Time Control Helpers ──

function updateTimeControl(state, now = Date.now()) {
  const clock = state.timeControl;
  if (!clock || state.phase === 'GAME_OVER') {
    return { enabled: false, paused: false, expired: false };
  }
  if (state.trickPendingResolve) {
    clock.serverNow = now;
    return { enabled: true, paused: true, expired: false };
  }

  clock.serverNow = now;
  if (clock.activeSince === null) {
    return { enabled: true, paused: true, expired: false };
  }

  const playerIndex = state.currentPlayerIndex;
  const remaining = Math.max(0, clock.playerTimeRemainingMs[playerIndex] ?? 0);
  const elapsed = Math.max(0, now - clock.activeSince);
  if (elapsed < remaining) {
    return { enabled: true, paused: false, expired: false };
  }

  clock.playerTimeRemainingMs[playerIndex] = 0;
  clock.activeSince = null;
  return { enabled: true, paused: false, expired: true };
}

function consumeTurnTime(state, playerIndex, now = Date.now()) {
  const clock = state.timeControl;
  if (!clock) return;
  if (clock.activeSince !== null) {
    const elapsed = Math.max(0, now - clock.activeSince);
    clock.playerTimeRemainingMs[playerIndex] = Math.max(
      0,
      (clock.playerTimeRemainingMs[playerIndex] ?? 0) - elapsed,
    );
  }
  clock.activeSince = now;
  clock.serverNow = now;
}

function addTimeIncrement(state, playerIndex, now = Date.now()) {
  const clock = state.timeControl;
  if (!clock) return;
  clock.playerTimeRemainingMs[playerIndex] =
    Math.max(0, clock.playerTimeRemainingMs[playerIndex] ?? 0) + clock.incrementMs;
  clock.serverNow = now;
}

function startTurnTimeControl(state, now = Date.now(), paused = false) {
  const clock = state.timeControl;
  if (!clock || state.phase === 'GAME_OVER') return;
  clock.activeSince = paused || state.trickPendingResolve ? null : now;
  clock.serverNow = now;
}

function pauseTurnTimeControl(state, playerIndex, now = Date.now()) {
  const clock = state.timeControl;
  if (!clock || state.phase === 'GAME_OVER' || state.currentPlayerIndex !== playerIndex) return;
  consumeTurnTime(state, playerIndex, now);
  clock.activeSince = null;
  clock.serverNow = now;
}

// ── Trick winner evaluation ──

function evaluateTrickWinner(currentTrick, contract) {
  const cards = currentTrick.cards;
  const leadSuit = currentTrick.leadSuit;
  const trumpSuit = contract && contract.strain < 4 ? contract.strain : null;

  let best = cards[0];
  for (let i = 1; i < cards.length; i++) {
    const entry = cards[i];
    const c = entry.card;
    const b = best.card;

    if (trumpSuit !== null) {
      if (c.suit === trumpSuit && b.suit !== trumpSuit) {
        best = entry;
      } else if (c.suit === trumpSuit && b.suit === trumpSuit && c.rank > b.rank) {
        best = entry;
      } else if (b.suit !== trumpSuit && c.suit === leadSuit && c.rank > b.rank) {
        best = entry;
      }
    } else {
      if (c.suit === leadSuit && c.rank > b.rank) {
        best = entry;
      }
    }
  }
  return best;
}

function finalizeGame(state, winnerSide, reason, forfeitingPlayerIndex = null) {
  state.phase = 'GAME_OVER';
  state.trickPendingResolve = null;
  if (state.timeControl) {
    state.timeControl.activeSince = null;
  }
  const lordTricks =
    state.declarerIndex !== null && state.partnerIndex !== null
      ? state.players[state.declarerIndex].tricksWon + state.players[state.partnerIndex].tricksWon
      : 0;
  const rebelTricks = state.players.reduce((sum, p, idx) => {
    if (idx === state.declarerIndex || idx === state.partnerIndex) return sum;
    return sum + p.tricksWon;
  }, 0);

  state.gameResult = {
    winnerSide,
    reason,
    forfeitingPlayerIndex,
    lordTricks,
    rebelTricks,
    ratingChanges: [],
  };
  state.gameResult.ratingChanges = calculateRatingChanges(state);
}

// ── Resolve the 1.5s paused trick ──

function resolvePendingTrick(state, now = Date.now()) {
  if (!state.trickPendingResolve || state.phase !== 'PLAYING') return null;

  const { winnerIndex, winningCardId } = state.trickPendingResolve;
  state.players[winnerIndex].tricksWon += 1;
  state.lastCompletedTrick = {
    trickNumber: state.trickNumber,
    cards: [...state.currentTrick.cards],
    winnerIndex,
    winningCardId,
  };
  state.trickPendingResolve = null;

  const lordTricks =
    state.players[state.declarerIndex].tricksWon +
    state.players[state.partnerIndex].tricksWon;
  const rebelTricks = state.players.reduce((sum, p, idx) => {
    if (idx === state.declarerIndex || idx === state.partnerIndex) return sum;
    return sum + p.tricksWon;
  }, 0);

  const { lordTarget, rebelTarget } = state.contract;

  if (lordTricks >= lordTarget) {
    finalizeGame(state, 'LORD_WIN', 'TRICKS');
    return { gameOver: true, winnerIndex };
  }

  if (rebelTricks >= rebelTarget || state.trickNumber >= 13) {
    finalizeGame(state, 'REBEL_WIN', 'TRICKS');
    return { gameOver: true, winnerIndex };
  }

  state.trickNumber += 1;
  state.currentTrick = {
    leaderIndex: winnerIndex,
    leadSuit: null,
    cards: [],
  };
  state.currentPlayerIndex = winnerIndex;
  state.turnNumber += 1;
  startTurnTimeControl(state, now, false);

  return { gameOver: false, winnerIndex };
}

// ── Process game actions ──

function processAction(state, playerIndex, action) {
  if (state.phase === 'GAME_OVER') return { error: 'Game is over' };
  if (state.trickPendingResolve) return { error: 'Wait for current trick to finish' };
  if (state.currentPlayerIndex !== playerIndex) return { error: 'Not your turn' };
  if (!action || typeof action.type !== 'string') return { error: 'Invalid action' };

  const result = { type: action.type, actingPlayer: playerIndex, payload: {} };

  switch (action.type) {
    case 'BID': {
      if (state.phase !== 'BIDDING') return { error: 'Bidding phase has ended' };
      const level = Number(action.level);
      const strain = Number(action.strain);
      if (!Number.isInteger(level) || level < 1 || level > 7) {
        return { error: 'Bid level must be between 1 and 7' };
      }
      if (!Number.isInteger(strain) || strain < 0 || strain > 4) {
        return { error: 'Invalid suit or No Trump' };
      }
      if (!isHigherBid(level, strain, state.highestBid)) {
        return { error: 'Bid must be higher than the current bid' };
      }

      state.highestBid = { level, strain, bidderIndex: playerIndex };
      state.consecutivePasses = 0;
      state.bidHistory.push({ playerIndex, type: 'BID', level, strain });
      state.currentPlayerIndex = (playerIndex + 1) % 4;
      state.turnNumber += 1;

      result.payload = { level, strain };
      return { ok: true, result, completed: true };
    }

    case 'PASS': {
      if (state.phase !== 'BIDDING') return { error: 'Bidding phase has ended' };
      if (!state.highestBid) {
        return { error: 'First bidder must make a bid (cannot Pass to open)' };
      }

      state.consecutivePasses += 1;
      state.bidHistory.push({ playerIndex, type: 'PASS' });
      state.turnNumber += 1;

      if (state.consecutivePasses >= 3) {
        const { level, strain, bidderIndex } = state.highestBid;
        const lordTarget = 6 + level;
        const rebelTarget = 14 - lordTarget;

        state.phase = 'CALL_PARTNER';
        state.declarerIndex = bidderIndex;
        state.contract = {
          level,
          strain,
          declarerIndex: bidderIndex,
          lordTarget,
          rebelTarget,
        };
        state.currentPlayerIndex = bidderIndex;
        result.payload = { biddingEnded: true, declarerIndex: bidderIndex, contract: state.contract };
      } else {
        state.currentPlayerIndex = (playerIndex + 1) % 4;
        result.payload = { biddingEnded: false };
      }

      return { ok: true, result, completed: true };
    }

    case 'CALL_CARD': {
      if (state.phase !== 'CALL_PARTNER') return { error: 'Not in partner calling phase' };
      if (playerIndex !== state.declarerIndex) return { error: 'Only the Lord can call a partner card' };

      const suit = Number(action.suit);
      const rank = Number(action.rank);
      if (!Number.isInteger(suit) || suit < 0 || suit > 3) {
        return { error: 'Invalid card suit' };
      }
      if (!Number.isInteger(rank) || rank < 2 || rank > 14) {
        return { error: 'Invalid card rank' };
      }

      const lordHand = state.players[playerIndex].hand;
      if (lordHand.some(c => c.suit === suit && c.rank === rank)) {
        return { error: 'Cannot call a card in your own hand (1v3 is not allowed)' };
      }

      const called = makeCard(suit, rank);
      let holderIndex = -1;
      for (let i = 0; i < 4; i++) {
        if (i === playerIndex) continue;
        if (state.players[i].hand.some(c => c.id === called.id)) {
          holderIndex = i;
          break;
        }
      }
      if (holderIndex === -1) {
        return { error: 'Called card not found in other hands' };
      }

      state.calledCard = called;
      state.partnerIndex = holderIndex;
      state.phase = 'PLAYING';
      // Lord ALWAYS leads the first trick regardless of contract strain
      state.currentPlayerIndex = state.declarerIndex;
      state.currentTrick = {
        leaderIndex: state.declarerIndex,
        leadSuit: null,
        cards: [],
      };
      state.turnNumber += 1;

      result.payload = { calledCard: called };
      return { ok: true, result, completed: true };
    }

    case 'PLAY_CARD': {
      if (state.phase !== 'PLAYING') return { error: 'Game is not in playing phase' };
      const cardId = Number(action.cardId);
      const player = state.players[playerIndex];
      const cardIdx = player.hand.findIndex(c => c.id === cardId);
      if (cardIdx === -1) return { error: 'Card not in hand' };

      const legalIds = getLegalCardIds(state, playerIndex);
      if (!legalIds.includes(cardId)) {
        const card = player.hand[cardIdx];
        if (
          state.currentTrick.cards.length === 0 &&
          state.contract.strain < 4 &&
          card.suit === state.contract.strain &&
          !state.trumpBroken
        ) {
          return { error: 'Trump has not been broken yet' };
        }
        return { error: 'Must follow the lead suit' };
      }

      const [card] = player.hand.splice(cardIdx, 1);
      if (state.currentTrick.cards.length === 0) {
        state.currentTrick.leaderIndex = playerIndex;
        state.currentTrick.leadSuit = card.suit;
      }
      state.currentTrick.cards.push({ playerIndex, card });

      const trumpSuit = state.contract.strain < 4 ? state.contract.strain : null;
      if (trumpSuit !== null && card.suit === trumpSuit) {
        state.trumpBroken = true;
      }

      if (state.currentTrick.cards.length < 4) {
        state.currentPlayerIndex = (playerIndex + 1) % 4;
        state.turnNumber += 1;
        result.payload = { card, trickComplete: false };
        return { ok: true, result, completed: true, trickComplete: false };
      }

      // 4th card played: evaluate winner and pause for 1.5s
      const best = evaluateTrickWinner(state.currentTrick, state.contract);
      const resolveAt = Date.now() + 1500;
      state.trickPendingResolve = {
        winnerIndex: best.playerIndex,
        winningCardId: best.card.id,
        resolveAt,
      };
      if (state.timeControl) {
        state.timeControl.activeSince = null;
      }

      result.payload = {
        card,
        trickComplete: true,
        winnerIndex: best.playerIndex,
        winningCardId: best.card.id,
      };
      return { ok: true, result, completed: true, trickComplete: true };
    }

    default:
      return { error: 'Unknown action' };
  }
}

function processResign(state, playerIndex, reason = 'FORFEIT') {
  if (state.phase === 'GAME_OVER') return;
  if (!state.resignedPlayers.includes(playerIndex)) {
    state.resignedPlayers.push(playerIndex);
  }

  let winnerSide = 'REBEL_WIN';
  if (state.declarerIndex !== null && state.partnerIndex !== null) {
    const isLordSide = playerIndex === state.declarerIndex || playerIndex === state.partnerIndex;
    winnerSide = isLordSide ? 'REBEL_WIN' : 'LORD_WIN';
  } else if (state.declarerIndex !== null) {
    winnerSide = playerIndex === state.declarerIndex ? 'REBEL_WIN' : 'LORD_WIN';
  }

  finalizeGame(state, winnerSide, reason, playerIndex);
}

module.exports = {
  SUIT_SYMBOLS,
  SUIT_NAMES,
  makeCard,
  cardFromId,
  buildDeck,
  sortHand,
  isHigherBid,
  getLegalCardIds,
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
};
