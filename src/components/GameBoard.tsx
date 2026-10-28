import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Maximize, Minimize, MoreVertical } from 'lucide-react';
import useGameStore from '../store/gameStore';
import Avatar from './Avatar';
import CardView from './CardView';
import type {
  GameState,
  PlayerView,
  Strain,
  Suit,
  TimeControlState,
} from '../types';
import {
  STRAIN_SYMBOLS,
  STRAIN_KEY_HINTS,
  SUIT_SYMBOLS,
  ALL_RANKS_DESC,
  formatRank,
  isRedSuit,
  parseKeyToStrain,
  parseKeyToSuit,
  parseKeyToRank,
} from '../constants';

function isLegalBidOption(
  level: number,
  strain: Strain,
  highestBid: GameState['highestBid'],
): boolean {
  if (!highestBid) return true;
  if (level > highestBid.level) return true;
  if (level === highestBid.level && strain > highestBid.strain) return true;
  return false;
}

export default function GameBoard() {
  const {
    gameState,
    playerIndex,
    sendAction,
    returnToLobby,
    quitRoom,
    resign,
    disconnectedPlayers,
    addToast,
  } = useGameStore();

  const [showMenu, setShowMenu] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Clock synchronization
  const [clockNow, setClockNow] = useState(Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);

  // Two-step Bidding selection state (supports suit->level OR level->suit, immediate submit)
  const [selectedStrain, setSelectedStrain] = useState<Strain | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null);

  // Two-step Partner Calling selection state (suit -> rank, immediate submit)
  const [callSuit, setCallSuit] = useState<Suit>(3); // Default Spades

  const fullscreenSupported =
    typeof document !== 'undefined' &&
    !!document.fullscreenEnabled &&
    typeof document.documentElement.requestFullscreen === 'function';

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        if (!document.fullscreenEnabled) return;
        await document.documentElement.requestFullscreen();
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (mode: 'landscape') => Promise<void>;
        };
        await orientation.lock?.('landscape').catch(() => {});
      } else {
        screen.orientation?.unlock?.();
        await document.exitFullscreen();
      }
    } catch {
      // Ignore on unsupported browsers
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  useEffect(() => {
    const serverNow = gameState?.timeControl?.serverNow;
    if (serverNow !== undefined) setServerClockOffset(serverNow - Date.now());
  }, [gameState?.timeControl?.serverNow]);

  useEffect(() => {
    if (!gameState?.timeControl) return;
    setClockNow(Date.now());
    const interval = setInterval(() => setClockNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [!!gameState?.timeControl]);

  // Reset bidding selection whenever turn or phase changes
  useEffect(() => {
    setSelectedStrain(null);
    setSelectedLevel(null);
  }, [gameState?.phase, gameState?.currentPlayerIndex, gameState?.turnNumber]);

  // ── Immediate Bid Submission Helper ──
  const trySubmitBid = useCallback(
    (level: number, strain: Strain) => {
      if (!gameState || gameState.phase !== 'BIDDING') return;
      if (gameState.currentPlayerIndex !== playerIndex) return;
      if (!isLegalBidOption(level, strain, gameState.highestBid)) {
        addToast('Bid must be higher than current bid', 'warn');
        return;
      }
      setSelectedStrain(null);
      setSelectedLevel(null);
      sendAction({ type: 'BID', level, strain });
    },
    [gameState, playerIndex, sendAction, addToast],
  );

  // ── Immediate Partner Call Submission Helper ──
  const trySubmitCallCard = useCallback(
    (suit: Suit, rank: number) => {
      if (!gameState || gameState.phase !== 'CALL_PARTNER') return;
      if (gameState.currentPlayerIndex !== playerIndex) return;
      const myHand = gameState.players[playerIndex]?.hand || [];
      if (myHand.some(c => c.suit === suit && c.rank === rank)) {
        addToast('Cannot call a card in your own hand (no 1v3)', 'warn');
        return;
      }
      sendAction({ type: 'CALL_CARD', suit, rank });
    },
    [gameState, playerIndex, sendAction, addToast],
  );

  // ── Keyboard Shortcuts for BIDDING and CALL_PARTNER (No keyboard for PLAYING) ──
  const stateRef = useRef({
    gameState,
    playerIndex,
    selectedStrain,
    selectedLevel,
    callSuit,
    trySubmitBid,
    trySubmitCallCard,
  });
  stateRef.current = {
    gameState,
    playerIndex,
    selectedStrain,
    selectedLevel,
    callSuit,
    trySubmitBid,
    trySubmitCallCard,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const {
        gameState: gs,
        playerIndex: pi,
        selectedStrain: curStrain,
        selectedLevel: curLevel,
        callSuit: curCallSuit,
        trySubmitBid: submitBid,
        trySubmitCallCard: submitCall,
      } = stateRef.current;

      if (!gs || gs.currentPlayerIndex !== pi) return;
      const key = e.key.toLowerCase();

      // 1. BIDDING keyboard shortcuts:
      // 'p' -> immediate PASS (if allowed)
      // '1'-'7' and 'c'/'d'/'h'/'s'/'n' -> immediate submit once both are chosen
      if (gs.phase === 'BIDDING') {
        if (key === 'p') {
          e.preventDefault();
          if (!gs.highestBid) {
            useGameStore.getState().addToast('First bidder must make an opening bid', 'warn');
            return;
          }
          useGameStore.getState().sendAction({ type: 'PASS' });
          return;
        }

        const num = Number(key);
        if (Number.isInteger(num) && num >= 1 && num <= 7) {
          e.preventDefault();
          if (curStrain !== null) {
            submitBid(num, curStrain);
          } else {
            setSelectedLevel(num);
          }
          return;
        }

        const strain = parseKeyToStrain(key);
        if (strain !== null) {
          e.preventDefault();
          if (curLevel !== null) {
            submitBid(curLevel, strain);
          } else {
            setSelectedStrain(strain);
          }
          return;
        }
      }

      // 2. CALL_PARTNER keyboard shortcuts:
      // 'c'/'d'/'h'/'s' selects suit; '2'-'9', 't'/'0', 'j', 'q', 'k', 'a' immediately submits rank
      if (gs.phase === 'CALL_PARTNER') {
        const suit = parseKeyToSuit(key);
        if (suit !== null) {
          e.preventDefault();
          setCallSuit(suit);
          return;
        }

        const rank = parseKeyToRank(key);
        if (rank !== null) {
          e.preventDefault();
          submitCall(curCallSuit, rank);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (!gameState || playerIndex < 0) {
    return (
      <div className="game-shell mahjong-felt-bg flex items-center justify-center">
        <div className="text-emerald-200/70 text-sm">Waiting for table state...</div>
      </div>
    );
  }

  const me = gameState.players[playerIndex];
  const isMyTurn =
    gameState.phase !== 'GAME_OVER' &&
    !gameState.trickPendingResolve &&
    gameState.currentPlayerIndex === playerIndex;

  // Relative seat indices around the 4-player table:
  // Bottom = Me, Left = +1, Top = +2, Right = +3
  const leftIdx = (playerIndex + 1) % 4;
  const topIdx = (playerIndex + 2) % 4;
  const rightIdx = (playerIndex + 3) % 4;

  const effectiveServerNow = clockNow + serverClockOffset;
  const activeClockSeat =
    gameState.phase !== 'GAME_OVER' && !gameState.trickPendingResolve
      ? gameState.currentPlayerIndex
      : -1;
  const clocks = gameState.players.map((_, idx) =>
    getPlayerClock(gameState.timeControl, idx, activeClockSeat, effectiveServerNow),
  );

  // During PLAYING phase, avatars disappear and only ID + tricksWon (starting from 0) + clock are shown
  const isPlayingPhase = gameState.phase === 'PLAYING' || gameState.phase === 'GAME_OVER';
  const legalSet = new Set(gameState.legalCardIds || []);

  return (
    <div className="game-shell mahjong-felt-bg mahjong-table-frame flex flex-col justify-between relative overflow-hidden px-2 py-1.5 sm:px-4 sm:py-2.5">
      {/* ── Top Bar: Contract Summary (left) + Top Opponent (center) + Controls (right) ── */}
      <div className="w-full flex items-center justify-between gap-2 z-20 flex-shrink-0">
        {/* Top-left: Minimal Contract & Partner Card info once bidding is done */}
        <div className="min-w-[120px] sm:min-w-[180px] flex items-center gap-2">
          {gameState.contract && (
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[#051c14]/80 border border-amber-400/20 text-xs font-mono-num">
              <span className="text-amber-200 font-bold">
                {gameState.contract.level}
                <span className={isRedSuit(gameState.contract.strain) ? 'text-rose-400' : 'text-amber-100'}>
                  {STRAIN_SYMBOLS[gameState.contract.strain]}
                </span>
              </span>
              {gameState.calledCard && (
                <>
                  <span className="text-emerald-200/40">·</span>
                  <span className="text-emerald-200/80">
                    伴{' '}
                    <strong
                      className={
                        isRedSuit(gameState.calledCard.suit) ? 'text-rose-400' : 'text-amber-100'
                      }
                    >
                      {SUIT_SYMBOLS[gameState.calledCard.suit]}
                      {formatRank(gameState.calledCard.rank)}
                    </strong>
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Top Seat (North Opponent) */}
        <div className="flex justify-center">
          <SeatPlaque
            player={gameState.players[topIdx]}
            seatIndex={topIdx}
            isCurrentTurn={activeClockSeat === topIdx}
            isLord={gameState.declarerIndex === topIdx}
            isDisconnected={disconnectedPlayers.has(gameState.players[topIdx].username)}
            showAvatar={!isPlayingPhase}
            clock={clocks[topIdx]}
          />
        </div>

        {/* Top-right: Fullscreen & Menu */}
        <div className="min-w-[120px] sm:min-w-[180px] flex items-center justify-end gap-1">
          {fullscreenSupported && (
            <button
              onClick={toggleFullscreen}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-emerald-200/70 hover:text-amber-200 hover:bg-black/25 transition cursor-pointer"
              title="Toggle fullscreen"
              aria-label="Toggle fullscreen"
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-emerald-200/70 hover:text-amber-200 hover:bg-black/25 transition cursor-pointer"
              aria-label="Open game menu"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {showMenu && (
              <div className="absolute right-0 top-9 bg-[#07241b]/95 rounded-xl shadow-2xl border border-amber-400/25 py-1 w-32 z-50">
                <button
                  onClick={() => {
                    setShowQuitConfirm(true);
                    setShowMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-amber-100 hover:bg-emerald-800/50 cursor-pointer"
                >
                  Quit Room
                </button>
                {gameState.phase !== 'GAME_OVER' && (
                  <button
                    onClick={() => {
                      setShowResignConfirm(true);
                      setShowMenu(false);
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-rose-400 hover:bg-rose-950/50 cursor-pointer"
                  >
                    Resign
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {showMenu && <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />}

      {/* ── Middle Stage: Left Seat + Center Table (Bidding / Partner Call / 4-Leaf Clover Trick) + Right Seat ── */}
      <div className="flex-1 min-h-0 w-full flex items-center justify-between gap-2 my-1 relative">
        {/* Left Seat (West Opponent) */}
        <div className="flex-shrink-0 z-10">
          <SeatPlaque
            player={gameState.players[leftIdx]}
            seatIndex={leftIdx}
            isCurrentTurn={activeClockSeat === leftIdx}
            isLord={gameState.declarerIndex === leftIdx}
            isDisconnected={disconnectedPlayers.has(gameState.players[leftIdx].username)}
            showAvatar={!isPlayingPhase}
            clock={clocks[leftIdx]}
          />
        </div>

        {/* Center Felt Area */}
        <div className="flex-1 h-full flex items-center justify-center relative min-w-0">
          {/* PHASE 1: BIDDING */}
          {gameState.phase === 'BIDDING' && (
            <BiddingCenterPanel
              gameState={gameState}
              isMyTurn={isMyTurn}
              selectedStrain={selectedStrain}
              selectedLevel={selectedLevel}
              onSelectStrain={strain => {
                if (selectedLevel !== null) {
                  trySubmitBid(selectedLevel, strain);
                } else {
                  setSelectedStrain(strain === selectedStrain ? null : strain);
                }
              }}
              onSelectLevel={level => {
                if (selectedStrain !== null) {
                  trySubmitBid(level, selectedStrain);
                } else {
                  setSelectedLevel(level === selectedLevel ? null : level);
                }
              }}
              onPass={() => sendAction({ type: 'PASS' })}
            />
          )}

          {/* PHASE 2: CALL_PARTNER */}
          {gameState.phase === 'CALL_PARTNER' && (
            <CallPartnerCenterPanel
              gameState={gameState}
              playerIndex={playerIndex}
              callSuit={callSuit}
              onSelectSuit={setCallSuit}
              onSelectRank={rank => trySubmitCallCard(callSuit, rank)}
            />
          )}

          {/* PHASE 3: PLAYING — Four-Leaf Clover (四叶草) Overlapping Trick Area */}
          {isPlayingPhase && (
            <FourLeafCloverTrick
              gameState={gameState}
              viewerIndex={playerIndex}
            />
          )}
        </div>

        {/* Right Seat (East Opponent) */}
        <div className="flex-shrink-0 z-10">
          <SeatPlaque
            player={gameState.players[rightIdx]}
            seatIndex={rightIdx}
            isCurrentTurn={activeClockSeat === rightIdx}
            isLord={gameState.declarerIndex === rightIdx}
            isDisconnected={disconnectedPlayers.has(gameState.players[rightIdx].username)}
            showAvatar={!isPlayingPhase}
            clock={clocks[rightIdx]}
          />
        </div>
      </div>

      {/* ── Bottom Area: Self Plaque + Single-Row 13-Card Hand with Wide Spacing ── */}
      <div className="w-full flex flex-col items-center gap-1.5 z-20 flex-shrink-0">
        {/* Self Plaque (Avatar hidden during PLAYING; shows ID + Tricks Won from 0 + Clock) */}
        <SeatPlaque
          player={me}
          seatIndex={playerIndex}
          isCurrentTurn={activeClockSeat === playerIndex}
          isLord={gameState.declarerIndex === playerIndex}
          isDisconnected={false}
          showAvatar={!isPlayingPhase}
          clock={clocks[playerIndex]}
        />

        {/* Single-Row Hand (1行, generous spacing, direct single-click play) */}
        <div className="w-full max-w-6xl flex items-center justify-center gap-1.5 sm:gap-2 md:gap-2.5 lg:gap-3 px-1.5 py-0.5 flex-nowrap">
          <AnimatePresence initial={false}>
            {me.hand.map(card => {
              const canPlay =
                gameState.phase === 'PLAYING' && isMyTurn && legalSet.has(card.id);
              const isDimmed =
                gameState.phase === 'PLAYING' && isMyTurn && !legalSet.has(card.id);

              return (
                <motion.div
                  key={card.id}
                  layout
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -24, scale: 0.85 }}
                  transition={{ duration: 0.16 }}
                  className="flex-1 min-w-[40px] max-w-[78px] flex justify-center"
                >
                  <CardView
                    card={card}
                    size="hand"
                    playable={canPlay}
                    disabled={isDimmed}
                    onClick={() => sendAction({ type: 'PLAY_CARD', cardId: card.id })}
                  />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Confirm Modals ── */}
      <AnimatePresence>
        {showQuitConfirm && (
          <ConfirmModal
            title="Quit Room?"
            message="This game will be closed and everyone will return to the lobby."
            confirmLabel="Quit"
            confirmColor="bg-amber-600"
            onConfirm={() => {
              quitRoom();
              setShowQuitConfirm(false);
            }}
            onCancel={() => setShowQuitConfirm(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showResignConfirm && (
          <ConfirmModal
            title="Resign Game?"
            message="Resigning forfeits the game for your side (-1 point)."
            confirmLabel="Resign"
            confirmColor="bg-rose-600"
            onConfirm={() => {
              resign();
              setShowResignConfirm(false);
            }}
            onCancel={() => setShowResignConfirm(false)}
          />
        )}
      </AnimatePresence>

      {/* ── Game Over & Identity Reveal Modal ── */}
      <AnimatePresence>
        {gameState.phase === 'GAME_OVER' && gameState.gameResult && (
          <GameOverModal gameState={gameState} onReturn={returnToLobby} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Seat Plaque:
// - In BIDDING / CALL_PARTNER: shows Avatar + ID + Clock
// - In PLAYING: Avatar disappears! Shows ONLY ID (+ 主公 tag) + Tricks Won (from 0) + Clock
// ═══════════════════════════════════════════════════════════

function SeatPlaque({
  player,
  isCurrentTurn,
  isLord,
  isDisconnected,
  showAvatar,
  clock,
}: {
  player: PlayerView;
  seatIndex: number;
  isCurrentTurn: boolean;
  isLord: boolean;
  isDisconnected: boolean;
  showAvatar: boolean;
  clock: { label: string; urgent: boolean } | null;
}) {
  return (
    <div
      className={`inline-flex items-center gap-2 sm:gap-2.5 px-2.5 sm:px-3.5 py-1 sm:py-1.5 rounded-xl border transition-all ${
        isCurrentTurn
          ? 'bg-[#104634]/95 border-amber-400 ring-2 ring-amber-400/35 shadow-lg'
          : 'bg-[#062118]/80 border-amber-400/20'
      }`}
    >
      {showAvatar && (
        <Avatar seed={player.avatarSeed} size={28} highlight={isCurrentTurn} />
      )}

      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={`text-xs sm:text-sm font-semibold truncate max-w-[96px] sm:max-w-[130px] ${
            isDisconnected ? 'text-emerald-200/40 line-through' : 'text-amber-50'
          }`}
        >
          {player.username}
        </span>
        {isLord && (
          <span className="text-[10px] font-bold text-amber-300 tracking-tight">
            [主公]
          </span>
        )}
      </div>

      {/* Tricks Won counter (starts from 0 during PLAYING) */}
      {!showAvatar && (
        <div className="flex items-baseline gap-0.5 pl-1 border-l border-amber-400/20 font-mono-num">
          <span className="text-sm sm:text-base font-bold text-amber-300">
            {player.tricksWon}
          </span>
          <span className="text-[10px] text-emerald-200/60">墩</span>
        </div>
      )}

      {/* Turn Clock */}
      {clock && (
        <span
          className={`text-xs font-mono-num pl-1 border-l border-amber-400/20 ${
            clock.urgent
              ? 'text-rose-400 font-bold animate-pulse'
              : isCurrentTurn
                ? 'text-amber-200 font-semibold'
                : 'text-emerald-200/55'
          }`}
        >
          {clock.label}
        </span>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Four-Leaf Clover (四叶草) Overlapping Trick Area
// Each card sits in its player's relative leaf quadrant (Top, Right, Bottom, Left),
// with later-played cards overlapping an inner corner of earlier-played cards via zIndex.
// ═══════════════════════════════════════════════════════════

const CLOVER_OFFSETS: Record<number, { x: number; y: number; rotate: number }> = {
  // 0: Bottom (Self) — lower-right leaf
  0: { x: 20, y: 38, rotate: -5 },
  // 1: Left — lower-left leaf
  1: { x: -48, y: 14, rotate: 6 },
  // 2: Top — upper-left leaf
  2: { x: -20, y: -38, rotate: -5 },
  // 3: Right — upper-right leaf
  3: { x: 48, y: -14, rotate: 6 },
};

function FourLeafCloverTrick({
  gameState,
  viewerIndex,
}: {
  gameState: GameState;
  viewerIndex: number;
}) {
  const trickCards = gameState.currentTrick.cards;
  const winningCardId = gameState.trickPendingResolve?.winningCardId ?? null;

  return (
    <div className="relative w-56 h-40 sm:w-64 sm:h-48 md:w-72 md:h-52 flex items-center justify-center select-none">
      {/* Subtle center mahjong table medallion */}
      <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full border border-amber-400/15 bg-[#07261c]/40 flex items-center justify-center pointer-events-none">
        <span className="text-[11px] font-mono-num text-emerald-200/40">
          第 {gameState.trickNumber} 墩
        </span>
      </div>

      <AnimatePresence>
        {trickCards.map((entry, playOrder) => {
          const relSeat = (entry.playerIndex - viewerIndex + 4) % 4;
          const pos = CLOVER_OFFSETS[relSeat] || { x: 0, y: 0, rotate: 0 };
          const isWinning = winningCardId === entry.card.id;

          return (
            <motion.div
              key={`${gameState.trickNumber}-${entry.card.id}`}
              initial={{
                opacity: 0,
                scale: 0.75,
                x: pos.x * 2.2,
                y: pos.y * 2.2,
                rotate: 0,
              }}
              animate={{
                opacity: 1,
                scale: isWinning ? 1.06 : 1,
                x: pos.x,
                y: pos.y,
                rotate: pos.rotate,
              }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              style={{ zIndex: 20 + playOrder * 10 }}
              className="absolute"
            >
              <CardView card={entry.card} size="trick" winning={isWinning} />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Bidding Panel:
// Step 1: Pick Suit / NT (or Pass)
// Step 2: Pick Level (1..7) -> Immediately submits!
// Also supports keyboard: 'P' = Pass, '1'-'7' + 'C'/'D'/'H'/'S'/'N' = Immediate Bid
// ═══════════════════════════════════════════════════════════

function BiddingCenterPanel({
  gameState,
  isMyTurn,
  selectedStrain,
  selectedLevel,
  onSelectStrain,
  onSelectLevel,
  onPass,
}: {
  gameState: GameState;
  isMyTurn: boolean;
  selectedStrain: Strain | null;
  selectedLevel: number | null;
  onSelectStrain: (strain: Strain) => void;
  onSelectLevel: (level: number) => void;
  onPass: () => void;
}) {
  const highest = gameState.highestBid;
  const highestBidderName =
    highest !== null ? gameState.players[highest.bidderIndex]?.username : null;
  const activeBidderName = gameState.players[gameState.currentPlayerIndex]?.username;
  const canPass = highest !== null; // First bidder MUST bid!

  return (
    <div className="bg-[#062219]/92 border border-amber-400/25 rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 shadow-2xl max-w-md w-full space-y-2.5">
      {/* Current highest bid header */}
      <div className="flex items-center justify-between gap-2 border-b border-amber-400/15 pb-2">
        <div className="text-xs text-emerald-200/80">
          {highest ? (
            <span>
              当前最高:{' '}
              <strong className="text-amber-300 font-mono-num text-sm">
                {highest.level}
                <span className={isRedSuit(highest.strain) ? 'text-rose-400' : 'text-amber-100'}>
                  {STRAIN_SYMBOLS[highest.strain]}
                </span>
              </strong>{' '}
              <span className="text-emerald-200/60">({highestBidderName})</span>
            </span>
          ) : (
            <span className="text-amber-200 font-medium">首家开叫（必叫，不可 Pass）</span>
          )}
        </div>
        <div className="text-[11px] text-emerald-200/60">
          {isMyTurn ? (
            <span className="text-amber-300 font-semibold">轮到你叫牌</span>
          ) : (
            <span>等待 {activeBidderName}...</span>
          )}
        </div>
      </div>

      {isMyTurn ? (
        <div className="space-y-2">
          {/* Row 1: Select Suit / NT + Pass */}
          <div className="flex items-center gap-1.5">
            {([0, 1, 2, 3, 4] as Strain[]).map(strain => {
              const active = selectedStrain === strain;
              // Check if at least level 7 is legal for this strain
              const anyLevelLegal = isLegalBidOption(7, strain, highest);
              const ifLevelPreselectedLegal =
                selectedLevel === null || isLegalBidOption(selectedLevel, strain, highest);
              const enabled = anyLevelLegal && ifLevelPreselectedLegal;

              return (
                <button
                  key={strain}
                  type="button"
                  disabled={!enabled}
                  onClick={() => onSelectStrain(strain)}
                  className={`flex-1 py-1.5 sm:py-2 rounded-xl border text-center transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                    active
                      ? 'bg-amber-500 text-[#062118] border-amber-300 font-bold shadow-md'
                      : 'bg-[#0b3527]/85 hover:bg-[#124936] text-amber-100 border-amber-400/20'
                  }`}
                >
                  <div
                    className={`text-sm sm:text-base font-bold leading-none ${
                      active
                        ? 'text-[#062118]'
                        : isRedSuit(strain)
                          ? 'text-rose-400'
                          : 'text-amber-100'
                    }`}
                  >
                    {STRAIN_SYMBOLS[strain]}
                  </div>
                  <div
                    className={`text-[9px] mt-0.5 font-mono-num ${
                      active ? 'text-[#062118]/80' : 'text-emerald-200/50'
                    }`}
                  >
                    [{STRAIN_KEY_HINTS[strain]}]
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              disabled={!canPass}
              onClick={onPass}
              title={canPass ? 'Pass (Key: P)' : 'First bidder must make a bid'}
              className="px-3 py-1.5 sm:py-2 rounded-xl border border-amber-400/20 bg-[#08291e] hover:bg-rose-950/60 hover:border-rose-400/40 text-amber-100 text-xs font-semibold transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <div>Pass</div>
              <div className="text-[9px] text-emerald-200/50 font-mono-num">[P]</div>
            </button>
          </div>

          {/* Row 2: Select Level (1..7) -> Immediately submits once Suit & Level are chosen */}
          <div className="flex items-center gap-1.5">
            {[1, 2, 3, 4, 5, 6, 7].map(level => {
              const legalForSelectedStrain =
                selectedStrain !== null
                  ? isLegalBidOption(level, selectedStrain, highest)
                  : ([0, 1, 2, 3, 4] as Strain[]).some(s => isLegalBidOption(level, s, highest));
              const active = selectedLevel === level;

              return (
                <button
                  key={level}
                  type="button"
                  disabled={!legalForSelectedStrain}
                  onClick={() => onSelectLevel(level)}
                  className={`flex-1 py-1.5 sm:py-2 rounded-xl border font-mono-num text-xs sm:text-sm font-bold transition cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed ${
                    active
                      ? 'bg-amber-500 text-[#062118] border-amber-300 shadow-md'
                      : 'bg-[#0b3527]/85 hover:bg-amber-500 hover:text-[#062118] text-amber-100 border-amber-400/20'
                  }`}
                >
                  {level}
                </button>
              );
            })}
          </div>

          <div className="text-[10px] text-emerald-200/55 text-center">
            点选花色再点档位直接出价 · 键盘支持按 <span className="font-mono-num">1-7</span> +{' '}
            <span className="font-mono-num">C/D/H/S/N</span> 或 <span className="font-mono-num">P</span>(Pass)
          </div>
        </div>
      ) : (
        <div className="py-2 text-center text-xs text-emerald-200/70">
          等待 <strong className="text-amber-200">{activeBidderName}</strong> 叫牌...
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Call Partner Card Panel (Lord chooses a non-self card -> Immediate submit)
// ═══════════════════════════════════════════════════════════

function CallPartnerCenterPanel({
  gameState,
  playerIndex,
  callSuit,
  onSelectSuit,
  onSelectRank,
}: {
  gameState: GameState;
  playerIndex: number;
  callSuit: Suit;
  onSelectSuit: (suit: Suit) => void;
  onSelectRank: (rank: number) => void;
}) {
  const isLord = gameState.declarerIndex === playerIndex;
  const lordName =
    gameState.declarerIndex !== null
      ? gameState.players[gameState.declarerIndex]?.username
      : '';
  const myHand = gameState.players[playerIndex]?.hand || [];

  if (!isLord) {
    return (
      <div className="bg-[#062219]/92 border border-amber-400/25 rounded-2xl px-5 py-4 shadow-2xl text-center space-y-1.5 max-w-sm">
        <div className="text-sm font-display font-bold text-amber-200">
          主公点将（选忠臣牌）
        </div>
        <div className="text-xs text-emerald-200/75">
          等待主公 <strong className="text-amber-100">{lordName}</strong> 指定一张非自己手上的队友牌...
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#062219]/95 border border-amber-400/30 rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 shadow-2xl max-w-md w-full space-y-2.5">
      <div className="flex items-center justify-between border-b border-amber-400/15 pb-1.5">
        <span className="text-xs sm:text-sm font-bold text-amber-200">
          你是主公 · 请指定忠臣牌（不可选自己手牌）
        </span>
        <span className="text-[10px] text-emerald-200/60 font-mono-num">
          目标 {gameState.contract?.lordTarget} 墩
        </span>
      </div>

      {/* Suit tabs */}
      <div className="flex gap-1.5">
        {([3, 2, 0, 1] as Suit[]).map(suit => {
          const active = callSuit === suit;
          return (
            <button
              key={suit}
              type="button"
              onClick={() => onSelectSuit(suit)}
              className={`flex-1 py-1.5 rounded-xl border text-xs sm:text-sm font-bold transition cursor-pointer ${
                active
                  ? 'bg-amber-500 text-[#062118] border-amber-300 shadow'
                  : 'bg-[#0b3527]/85 hover:bg-[#124936] text-amber-100 border-amber-400/20'
              }`}
            >
              <span className={active ? 'text-[#062118]' : isRedSuit(suit) ? 'text-rose-400' : ''}>
                {SUIT_SYMBOLS[suit]}
              </span>{' '}
              <span className="text-[10px] font-mono-num opacity-75">
                [{STRAIN_KEY_HINTS[suit]}]
              </span>
            </button>
          );
        })}
      </div>

      {/* Ranks 2..A (own cards disabled) */}
      <div className="grid grid-cols-7 gap-1">
        {ALL_RANKS_DESC.map(rank => {
          const inOwnHand = myHand.some(c => c.suit === callSuit && c.rank === rank);
          return (
            <button
              key={rank}
              type="button"
              disabled={inOwnHand}
              onClick={() => onSelectRank(rank)}
              title={inOwnHand ? 'In your hand (cannot self-call)' : `Call ${SUIT_SYMBOLS[callSuit]}${formatRank(rank)}`}
              className="py-1.5 rounded-lg border border-amber-400/20 bg-[#0b3527]/90 hover:bg-amber-500 hover:text-[#062118] text-amber-100 text-xs font-mono-num font-bold transition cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
            >
              {formatRank(rank)}
            </button>
          );
        })}
      </div>

      <div className="text-[10px] text-emerald-200/55 text-center">
        点击点数直接提交 · 键盘支持按 <span className="font-mono-num">S/H/C/D</span> 选花色再按{' '}
        <span className="font-mono-num">A/K/Q/J/T/9-2</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Game Over & Identity Reveal Modal (+1 / -1 scoring)
// ═══════════════════════════════════════════════════════════

function GameOverModal({
  gameState,
  onReturn,
}: {
  gameState: GameState;
  onReturn: () => void;
}) {
  const result = gameState.gameResult!;
  const lordWon = result.winnerSide === 'LORD_WIN';

  const roleBadge = (role: PlayerView['role']) => {
    if (role === 'LORD') return { label: '主公', cls: 'text-amber-300' };
    if (role === 'LOYALIST') return { label: '忠臣', cls: 'text-emerald-300' };
    return { label: '反贼', cls: 'text-rose-300' };
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 bg-black/65 z-50 flex items-center justify-center p-3"
    >
      <motion.div
        initial={{ scale: 0.9 }}
        animate={{ scale: 1 }}
        className="bg-[#07241b] border border-amber-400/35 rounded-2xl p-4 sm:p-6 max-w-md w-full space-y-3.5 shadow-2xl max-h-[calc(100dvh-1rem)] overflow-y-auto"
      >
        <div className="text-center space-y-1">
          <h2 className="text-xl sm:text-2xl font-display font-bold text-amber-300">
            {lordWon ? '主公 & 忠臣 获胜' : '反贼方 获胜'}
          </h2>
          <p className="text-xs text-emerald-200/75 font-mono-num">
            {gameState.contract && (
              <>
                定约 {gameState.contract.level}
                {STRAIN_SYMBOLS[gameState.contract.strain]} · 主忠 {result.lordTricks}/
                {gameState.contract.lordTarget} 墩 · 反贼 {result.rebelTricks}/
                {gameState.contract.rebelTarget} 墩
              </>
            )}
          </p>
        </div>

        {/* All 4 players' revealed identities, tricks won, and +1 / -1 score delta */}
        <div className="space-y-1.5">
          {gameState.players.map((p, idx) => {
            const delta = result.ratingChanges[idx] ?? 0;
            const rb = roleBadge(p.role);
            return (
              <div
                key={p.username}
                className={`flex items-center justify-between px-3.5 py-2 rounded-xl border ${
                  delta > 0
                    ? 'bg-[#114835]/90 border-amber-400/35'
                    : 'bg-[#092b20]/70 border-amber-400/10'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-xs font-bold ${rb.cls}`}>[{rb.label}]</span>
                  <span className="text-sm font-medium text-amber-50 truncate">
                    {p.username}
                  </span>
                </div>
                <div className="flex items-center gap-3 font-mono-num text-xs">
                  <span className="text-emerald-200/75">{p.tricksWon} 墩</span>
                  <span
                    className={`font-bold text-sm ${
                      delta > 0 ? 'text-amber-300' : 'text-rose-400'
                    }`}
                  >
                    {delta > 0 ? `+${delta}` : delta}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <button
          onClick={onReturn}
          className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-[#062118] rounded-xl font-semibold transition text-sm shadow-md cursor-pointer"
        >
          Return to Lobby
        </button>
      </motion.div>
    </motion.div>
  );
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  confirmColor,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmColor: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3"
    >
      <motion.div
        initial={{ scale: 0.92 }}
        animate={{ scale: 1 }}
        exit={{ scale: 0.92 }}
        className="bg-[#07241b] rounded-2xl p-5 w-full max-w-xs space-y-3.5 border border-amber-400/30 shadow-2xl"
      >
        <h3 className="text-base font-display font-bold text-center text-amber-100">{title}</h3>
        <p className="text-xs text-emerald-200/75 text-center">{message}</p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2 bg-[#0b3527] hover:bg-[#124936] border border-amber-400/20 rounded-xl text-xs transition text-amber-100 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-2 ${confirmColor} hover:opacity-90 text-white rounded-xl text-xs font-semibold transition shadow-sm cursor-pointer`}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function getPlayerClock(
  timeControl: TimeControlState | null,
  playerIndex: number,
  currentPlayerIndex: number,
  now: number,
): { label: string; urgent: boolean } | null {
  if (!timeControl) return null;
  const storedTime = Math.max(0, timeControl.playerTimeRemainingMs[playerIndex] ?? 0);
  const isActive = playerIndex === currentPlayerIndex;
  if (isActive && timeControl.activeSince !== null) {
    const elapsed = Math.max(0, now - timeControl.activeSince);
    const remaining = Math.max(0, storedTime - elapsed);
    return { label: formatMainTime(remaining), urgent: remaining <= 10_000 };
  }
  return { label: formatMainTime(storedTime), urgent: false };
}

function formatMainTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
