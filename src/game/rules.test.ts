import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  makeCard,
  createInitialGameState,
  clientViewForPlayer,
  processAction,
  resolvePendingTrick,
} = require('../../server/gameLogic.js');
const replayRecorder = require('../../server/replayRecorder.js');
const replayStore = require('../../server/replayStore.js');

const mockPlayers = [
  { username: 'Alice', avatarSeed: 1 },
  { username: 'Bob', avatarSeed: 2 },
  { username: 'Charlie', avatarSeed: 3 },
  { username: 'Diana', avatarSeed: 4 },
];

test('initial state deals 13 cards to each of 4 players and starts in BIDDING with 1.5m + 10s clock', () => {
  const state = createInitialGameState(mockPlayers, { firstPlayerIndex: 0, unlimitedTime: false });
  assert.equal(state.phase, 'BIDDING');
  assert.equal(state.currentPlayerIndex, 0);
  assert.equal(state.players.length, 4);
  for (const p of state.players) {
    assert.equal(p.hand.length, 13);
    assert.equal(p.tricksWon, 0);
  }
  assert.ok(state.timeControl);
  assert.equal(state.timeControl.mainTimeMs, 90000);
  assert.equal(state.timeControl.incrementMs, 10000);
});

test('first bidder must bid and cannot Pass on opening', () => {
  const state = createInitialGameState(mockPlayers, { firstPlayerIndex: 0, unlimitedTime: true });
  const passAttempt = processAction(state, 0, { type: 'PASS' });
  assert.ok(passAttempt.error);
  assert.equal(state.currentPlayerIndex, 0);

  const bidAttempt = processAction(state, 0, { type: 'BID', level: 1, strain: 0 });
  assert.equal(bidAttempt.ok, true);
  assert.equal(state.currentPlayerIndex, 1);
  assert.deepEqual(state.highestBid, { level: 1, strain: 0, bidderIndex: 0 });
});

test('bidding enforces strictly higher bids and transitions to CALL_PARTNER after 3 consecutive passes', () => {
  const state = createInitialGameState(mockPlayers, { firstPlayerIndex: 0, unlimitedTime: true });
  assert.equal(processAction(state, 0, { type: 'BID', level: 2, strain: 2 }).ok, true);

  assert.ok(processAction(state, 1, { type: 'BID', level: 2, strain: 2 }).error);
  assert.ok(processAction(state, 1, { type: 'BID', level: 2, strain: 1 }).error);

  assert.equal(processAction(state, 1, { type: 'BID', level: 2, strain: 3 }).ok, true);

  assert.equal(processAction(state, 2, { type: 'PASS' }).ok, true);
  assert.equal(processAction(state, 3, { type: 'PASS' }).ok, true);
  assert.equal(processAction(state, 0, { type: 'PASS' }).ok, true);

  assert.equal(state.phase, 'CALL_PARTNER');
  assert.equal(state.declarerIndex, 1);
  assert.equal(state.currentPlayerIndex, 1);
  assert.equal(state.contract.lordTarget, 8);
  assert.equal(state.contract.rebelTarget, 6);
});

test('Lord cannot call own card (no 1v3) and always leads the first trick even in trump contracts', () => {
  const state = createInitialGameState(mockPlayers, { firstPlayerIndex: 2, unlimitedTime: true });
  processAction(state, 2, { type: 'BID', level: 1, strain: 1 });
  processAction(state, 3, { type: 'PASS' });
  processAction(state, 0, { type: 'PASS' });
  processAction(state, 1, { type: 'PASS' });

  assert.equal(state.phase, 'CALL_PARTNER');
  assert.equal(state.declarerIndex, 2);

  const ownCard = state.players[2].hand[0];
  const selfCall = processAction(state, 2, { type: 'CALL_CARD', suit: ownCard.suit, rank: ownCard.rank });
  assert.ok(selfCall.error);

  const partnerCard = state.players[0].hand[0];
  const validCall = processAction(state, 2, { type: 'CALL_CARD', suit: partnerCard.suit, rank: partnerCard.rank });
  assert.equal(validCall.ok, true);
  assert.equal(state.phase, 'PLAYING');
  assert.equal(state.partnerIndex, 0);
  assert.equal(state.currentPlayerIndex, 2);

  const viewForSeat1 = clientViewForPlayer(state, 1);
  assert.equal(viewForSeat1.partnerIndex, null);
  assert.equal(viewForSeat1.players[0].role, null);
  assert.equal(viewForSeat1.players[2].role, 'LORD');
});

test('trump broken rule and early victory reveal +1 / -1 scoring work accurately', () => {
  const state = createInitialGameState(mockPlayers, { firstPlayerIndex: 0, unlimitedTime: true });
  state.phase = 'PLAYING';
  state.declarerIndex = 0;
  state.partnerIndex = 2;
  state.contract = { level: 7, strain: 3, declarerIndex: 0, lordTarget: 13, rebelTarget: 1 };
  state.calledCard = makeCard(2, 14);
  state.currentPlayerIndex = 0;
  state.trumpBroken = false;

  state.players[0].hand = [makeCard(3, 14), makeCard(2, 10)];
  state.players[1].hand = [makeCard(2, 14), makeCard(0, 2)];
  state.players[2].hand = [makeCard(2, 3), makeCard(0, 3)];
  state.players[3].hand = [makeCard(2, 4), makeCard(0, 4)];

  const illegalTrumpLead = processAction(state, 0, { type: 'PLAY_CARD', cardId: makeCard(3, 14).id });
  assert.ok(illegalTrumpLead.error);

  assert.equal(processAction(state, 0, { type: 'PLAY_CARD', cardId: makeCard(2, 10).id }).ok, true);
  assert.equal(processAction(state, 1, { type: 'PLAY_CARD', cardId: makeCard(2, 14).id }).ok, true);
  assert.equal(processAction(state, 2, { type: 'PLAY_CARD', cardId: makeCard(2, 3).id }).ok, true);
  const fourthPlay = processAction(state, 3, { type: 'PLAY_CARD', cardId: makeCard(2, 4).id });
  assert.equal(fourthPlay.ok, true);
  assert.equal(fourthPlay.trickComplete, true);
  assert.ok(state.trickPendingResolve);
  assert.equal(state.trickPendingResolve.winnerIndex, 1);

  const resolved = resolvePendingTrick(state);
  assert.equal(resolved.gameOver, true);
  assert.equal(state.phase, 'GAME_OVER');
  assert.equal(state.gameResult.winnerSide, 'REBEL_WIN');
  assert.deepEqual(state.gameResult.ratingChanges, [-1, 1, -1, 1]);

  const finalView = clientViewForPlayer(state, 1);
  assert.equal(finalView.partnerIndex, 2);
  assert.equal(finalView.players[0].role, 'LORD');
  assert.equal(finalView.players[1].role, 'REBEL');
  assert.equal(finalView.players[2].role, 'LOYALIST');
  assert.equal(finalView.players[3].role, 'REBEL');
});

test('replay recorder and replayEngine reconstruct full game frames accurately', async () => {
  replayStore.reset();
  const state = createInitialGameState(mockPlayers, { firstPlayerIndex: 0, unlimitedTime: true });
  const room = { id: 'game-1725280000000-test', createdAt: 1725280000000, state };
  replayRecorder.begin(room);

  // Bid 7 NT (rebelTarget = 1)
  const b1 = processAction(state, 0, { type: 'BID', level: 7, strain: 4 });
  replayRecorder.onActionResult(room, b1.result);
  for (const seat of [1, 2, 3]) {
    const p = processAction(state, seat, { type: 'PASS' });
    replayRecorder.onActionResult(room, p.result);
  }

  // Seat 0 calls a card from Seat 2's hand
  const called = state.players[2].hand[0];
  const cRes = processAction(state, 0, { type: 'CALL_CARD', suit: called.suit, rank: called.rank });
  replayRecorder.onActionResult(room, cRes.result);

  // Play 1 trick where someone wins
  for (let i = 0; i < 4; i++) {
    const actor = state.currentPlayerIndex;
    const legalIds = clientViewForPlayer(state, actor).legalCardIds;
    const playRes = processAction(state, actor, { type: 'PLAY_CARD', cardId: legalIds[0] });
    replayRecorder.onActionResult(room, playRes.result);
  }
  // Resign to end if not already ended
  if (state.phase !== 'GAME_OVER') {
    resolvePendingTrick(state);
  }
  if (state.phase !== 'GAME_OVER') {
    replayRecorder.onResign(room, 0);
    const { processResign } = require('../../server/gameLogic.js');
    processResign(state, 0, 'FORFEIT');
  }

  const saved = replayRecorder.finish(room);
  assert.ok(saved);

  const list = await replayStore.listGames();
  assert.equal(list.total, 1);
  assert.equal(list.games[0].id, room.id);

  const reconstructed = await replayStore.getFrames(room.id);
  assert.ok(reconstructed);
  assert.ok(reconstructed.frames.length >= 6);
  const lastFrame = reconstructed.frames[reconstructed.frames.length - 1];
  assert.equal(lastFrame.state.phase, 'GAME_OVER');
});
