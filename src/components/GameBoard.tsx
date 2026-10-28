import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Maximize, Minimize, MoreVertical } from 'lucide-react';
import useGameStore from '../store/gameStore';
import {
  ContractBadge,
  HandRow,
  Seat,
  TableLayout,
  TrickArea,
  callsOverhang,
  seatCalls,
  standingBidIndex,
  useTableMetrics,
} from './Table';
import type { SeatInfo, TableMetrics } from './Table';
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
    addToast,
  } = useGameStore();
  const metrics = useTableMetrics();

  const [showMenu, setShowMenu] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Clock synchronization (also drives the disconnect countdown)
  const [clockNow, setClockNow] = useState(Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);

  // Two-step Bidding selection state (supports suit->level OR level->suit, immediate submit)
  const [selectedStrain, setSelectedStrain] = useState<Strain | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null);

  // Partner calling: pick suit and rank, then confirm (the call cannot be undone)
  const [callSuit, setCallSuit] = useState<Suit>(3); // Default Spades
  const [callRank, setCallRank] = useState<number | null>(null);

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

  const serverStamp = gameState?.serverNow ?? gameState?.timeControl?.serverNow;
  useEffect(() => {
    if (serverStamp !== undefined) setServerClockOffset(serverStamp - Date.now());
  }, [serverStamp]);

  const needsTick =
    !!gameState?.timeControl || !!gameState?.players.some(p => p.disconnectDeadline);
  useEffect(() => {
    if (!needsTick) return;
    setClockNow(Date.now());
    const interval = setInterval(() => setClockNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [needsTick]);

  // Reset bidding selection whenever turn or phase changes
  useEffect(() => {
    setSelectedStrain(null);
    setSelectedLevel(null);
  }, [gameState?.phase, gameState?.currentPlayerIndex, gameState?.turnNumber]);

  useEffect(() => {
    setCallRank(null);
  }, [gameState?.phase, callSuit]);

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

  // ── Partner Call Helpers ──
  const trySelectCallRank = useCallback(
    (suit: Suit, rank: number) => {
      if (!gameState || gameState.phase !== 'CALL_PARTNER') return;
      if (gameState.currentPlayerIndex !== playerIndex) return;
      const myHand = gameState.players[playerIndex]?.hand || [];
      if (myHand.some(c => c.suit === suit && c.rank === rank)) {
        addToast('Cannot call a card in your own hand (no 1v3)', 'warn');
        return;
      }
      setCallRank(rank);
    },
    [gameState, playerIndex, addToast],
  );

  const confirmCall = useCallback(() => {
    if (!gameState || gameState.phase !== 'CALL_PARTNER' || callRank === null) return;
    if (gameState.currentPlayerIndex !== playerIndex) return;
    sendAction({ type: 'CALL_CARD', suit: callSuit, rank: callRank });
  }, [gameState, playerIndex, callSuit, callRank, sendAction]);

  // ── Keyboard Shortcuts for BIDDING and CALL_PARTNER (No keyboard for PLAYING) ──
  const stateRef = useRef({
    gameState,
    playerIndex,
    selectedStrain,
    selectedLevel,
    callSuit,
    trySubmitBid,
    trySelectCallRank,
    confirmCall,
  });
  stateRef.current = {
    gameState,
    playerIndex,
    selectedStrain,
    selectedLevel,
    callSuit,
    trySubmitBid,
    trySelectCallRank,
    confirmCall,
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
        trySelectCallRank: selectRank,
        confirmCall: confirm,
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
      // 'c'/'d'/'h'/'s' selects suit; '2'-'9', 't'/'0', 'j', 'q', 'k', 'a' selects rank; Enter confirms
      if (gs.phase === 'CALL_PARTNER') {
        if (key === 'enter') {
          e.preventDefault();
          confirm();
          return;
        }

        const suit = parseKeyToSuit(key);
        if (suit !== null) {
          e.preventDefault();
          setCallSuit(suit);
          return;
        }

        const rank = parseKeyToRank(key);
        if (rank !== null) {
          e.preventDefault();
          selectRank(curCallSuit, rank);
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

  // During PLAYING phase, avatars disappear and only ID + tricksWon (starting from 0) + clock are shown
  const isPlayingPhase = gameState.phase === 'PLAYING' || gameState.phase === 'GAME_OVER';
  const bidding = gameState.phase === 'BIDDING';
  const standingBid = standingBidIndex(gameState.bidHistory);

  const seatInfo = (idx: number): SeatInfo => {
    const player = gameState.players[idx];
    const offline = player.connected === false && gameState.phase !== 'GAME_OVER';
    const isLord = gameState.declarerIndex === idx;
    return {
      player,
      isTurn: activeClockSeat === idx,
      roleTag: isLord ? '主公' : null,
      calledCard: isLord ? gameState.calledCard : null,
      showAvatar: !isPlayingPhase,
      showTricks: isPlayingPhase,
      clock: getPlayerClock(gameState.timeControl, idx, activeClockSeat, effectiveServerNow),
      offlineLabel: offline
        ? player.disconnectDeadline
          ? `断线 ${formatMainTime(player.disconnectDeadline - effectiveServerNow)}`
          : '断线'
        : null,
      calls: seatCalls(gameState.bidHistory, idx),
      callPending: bidding && gameState.currentPlayerIndex === idx,
      highlightCall: standingBid,
      dimCalls: !bidding,
    };
  };

  const topInfo = seatInfo(topIdx);
  const selfInfo = seatInfo(playerIndex);

  const playableIds = new Set(
    gameState.phase === 'PLAYING' && isMyTurn ? gameState.legalCardIds || [] : [],
  );
  const dimmedIds = new Set(
    gameState.phase === 'PLAYING' && isMyTurn
      ? me.hand.filter(card => !playableIds.has(card.id)).map(card => card.id)
      : [],
  );

  const controls = (
    <>
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
    </>
  );

  let center: React.ReactNode;
  if (gameState.phase === 'BIDDING') {
    center = (
      <BiddingCenterPanel
        gameState={gameState}
        isMyTurn={isMyTurn}
        metrics={metrics}
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
    );
  } else if (gameState.phase === 'CALL_PARTNER') {
    center = (
      <CallPartnerCenterPanel
        gameState={gameState}
        playerIndex={playerIndex}
        metrics={metrics}
        callSuit={callSuit}
        callRank={callRank}
        onSelectSuit={setCallSuit}
        onSelectRank={rank => trySelectCallRank(callSuit, rank)}
        onConfirm={confirmCall}
      />
    );
  } else {
    // PHASE 3: PLAYING — Four-Leaf Clover (四叶草) Overlapping Trick Area
    center = (
      <TrickArea
        trick={gameState.currentTrick}
        trickNumber={gameState.trickNumber}
        viewerIndex={playerIndex}
        winningCardId={gameState.trickPendingResolve?.winningCardId ?? null}
        metrics={metrics}
      />
    );
  }

  return (
    <TableLayout
      metrics={metrics}
      topLeft={<ContractBadge contract={gameState.contract} />}
      topRight={controls}
      top={<Seat info={topInfo} side="top" metrics={metrics} />}
      left={<Seat info={seatInfo(leftIdx)} side="left" metrics={metrics} />}
      right={<Seat info={seatInfo(rightIdx)} side="right" metrics={metrics} />}
      center={center}
      self={<Seat info={selfInfo} side="self" metrics={metrics} />}
      hand={
        <HandRow
          cards={me.hand}
          metrics={metrics}
          playableIds={playableIds}
          dimmedIds={dimmedIds}
          onPlay={cardId => sendAction({ type: 'PLAY_CARD', cardId })}
        />
      }
      insetTop={metrics.portrait ? 0 : callsOverhang(topInfo, metrics.bidRows.top, metrics)}
      insetBottom={callsOverhang(selfInfo, metrics.bidRows.self, metrics)}
    >
      {showMenu && <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />}

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
    </TableLayout>
  );
}

// ═══════════════════════════════════════════════════════════
// Bidding Panel:
// Pick Suit / NT and Level in either order -> the second pick submits
// Also supports keyboard: 'P' = Pass, '1'-'7' + 'C'/'D'/'H'/'S'/'N' = Immediate Bid
// Everyone's calls are shown next to their own seat, so this panel only needs the standing bid.
// ═══════════════════════════════════════════════════════════

function BiddingCenterPanel({
  gameState,
  isMyTurn,
  metrics,
  selectedStrain,
  selectedLevel,
  onSelectStrain,
  onSelectLevel,
  onPass,
}: {
  gameState: GameState;
  isMyTurn: boolean;
  metrics: TableMetrics;
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
  const compact = metrics.compact;
  const showKeys = metrics.canHover;

  const standing = highest && (
    <>
      当前最高{' '}
      <strong className="text-amber-300 font-mono-num text-sm">
        {highest.level}
        <span className={isRedSuit(highest.strain) ? 'text-rose-400' : 'text-amber-100'}>
          {STRAIN_SYMBOLS[highest.strain]}
        </span>
      </strong>{' '}
      <span className="text-emerald-200/60">({highestBidderName})</span>
    </>
  );

  if (!isMyTurn) {
    return (
      <div className="bg-[#062219]/90 border border-amber-400/25 rounded-xl px-3.5 py-2 shadow-xl text-center text-xs text-emerald-200/80 max-w-full">
        {standing ? <>{standing} · </> : <span className="text-amber-200">首家开叫 · </span>}
        等待 <strong className="text-amber-200">{activeBidderName}</strong> 叫牌…
      </div>
    );
  }

  const buttonHeight = compact ? 'h-8' : 'h-10 sm:h-11';

  return (
    <div
      className={`bg-[#062219]/92 border border-amber-400/25 rounded-2xl shadow-2xl w-full ${
        compact ? 'max-w-[400px] px-2.5 py-2 space-y-1.5' : 'max-w-md px-4 py-3 sm:px-5 sm:py-3.5 space-y-2.5'
      }`}
    >
      {/* Current highest bid header */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-emerald-200/80 truncate">
          {standing || <span className="text-amber-200 font-medium">首家开叫（必叫，不可 Pass）</span>}
        </span>
        <span className="text-amber-300 font-semibold flex-shrink-0">轮到你叫牌</span>
      </div>

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
              className={`flex-1 ${buttonHeight} rounded-xl border flex flex-col items-center justify-center transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                active
                  ? 'bg-amber-500 text-[#062118] border-amber-300 font-bold shadow-md'
                  : 'bg-[#0b3527]/85 hover:bg-[#124936] text-amber-100 border-amber-400/20'
              }`}
            >
              <span
                className={`text-sm sm:text-base font-bold leading-none ${
                  active ? 'text-[#062118]' : isRedSuit(strain) ? 'text-rose-400' : 'text-amber-100'
                }`}
              >
                {STRAIN_SYMBOLS[strain]}
              </span>
              {showKeys && !compact && (
                <span
                  className={`text-[9px] mt-0.5 font-mono-num ${
                    active ? 'text-[#062118]/80' : 'text-emerald-200/50'
                  }`}
                >
                  [{STRAIN_KEY_HINTS[strain]}]
                </span>
              )}
            </button>
          );
        })}

        <button
          type="button"
          disabled={!canPass}
          onClick={onPass}
          title={canPass ? 'Pass (Key: P)' : 'First bidder must make a bid'}
          className={`px-3 ${buttonHeight} rounded-xl border border-amber-400/20 bg-[#08291e] hover:bg-rose-950/60 hover:border-rose-400/40 text-amber-100 text-xs font-semibold flex flex-col items-center justify-center transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed`}
        >
          <span>Pass</span>
          {showKeys && !compact && <span className="text-[9px] text-emerald-200/50 font-mono-num">[P]</span>}
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
              className={`flex-1 ${buttonHeight} rounded-xl border font-mono-num text-xs sm:text-sm font-bold transition cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed ${
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

      {showKeys && !compact && (
        <div className="text-[10px] text-emerald-200/55 text-center">
          点选花色再点档位直接出价 · 键盘支持按 <span className="font-mono-num">1-7</span> +{' '}
          <span className="font-mono-num">C/D/H/S/N</span> 或 <span className="font-mono-num">P</span>(Pass)
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Call Partner Card Panel (Lord chooses a non-self card, then confirms)
// ═══════════════════════════════════════════════════════════

function CallPartnerCenterPanel({
  gameState,
  playerIndex,
  metrics,
  callSuit,
  callRank,
  onSelectSuit,
  onSelectRank,
  onConfirm,
}: {
  gameState: GameState;
  playerIndex: number;
  metrics: TableMetrics;
  callSuit: Suit;
  callRank: number | null;
  onSelectSuit: (suit: Suit) => void;
  onSelectRank: (rank: number) => void;
  onConfirm: () => void;
}) {
  const isLord = gameState.declarerIndex === playerIndex;
  const lordName =
    gameState.declarerIndex !== null
      ? gameState.players[gameState.declarerIndex]?.username
      : '';
  const myHand = gameState.players[playerIndex]?.hand || [];
  const compact = metrics.compact;

  if (!isLord) {
    return (
      <div className="bg-[#062219]/90 border border-amber-400/25 rounded-xl px-3.5 py-2 shadow-xl text-center text-xs text-emerald-200/80 max-w-full">
        <span className="font-bold text-amber-200">主公点将</span> · 等待主公{' '}
        <strong className="text-amber-100">{lordName}</strong> 指定一张非自己手上的队友牌…
      </div>
    );
  }

  const buttonHeight = compact ? 'h-7' : 'h-9';

  return (
    <div
      className={`bg-[#062219]/95 border border-amber-400/30 rounded-2xl shadow-2xl w-full ${
        compact ? 'max-w-[480px] px-2.5 py-2 space-y-1.5' : 'max-w-[480px] px-4 py-3 sm:px-5 sm:py-3.5 space-y-2.5'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs sm:text-sm font-bold text-amber-200 truncate">
          你是主公 · 指定忠臣牌（不能选自己手牌）
        </span>
        <span className="text-[10px] text-emerald-200/60 font-mono-num flex-shrink-0">
          目标 {gameState.contract?.lordTarget} 墩
        </span>
      </div>

      {/* Suit tabs + confirm */}
      <div className="flex gap-1.5">
        {([3, 2, 0, 1] as Suit[]).map(suit => {
          const active = callSuit === suit;
          return (
            <button
              key={suit}
              type="button"
              onClick={() => onSelectSuit(suit)}
              className={`flex-1 ${buttonHeight} rounded-xl border text-sm font-bold transition cursor-pointer ${
                active
                  ? 'bg-amber-500 text-[#062118] border-amber-300 shadow'
                  : 'bg-[#0b3527]/85 hover:bg-[#124936] text-amber-100 border-amber-400/20'
              }`}
            >
              <span className={active ? 'text-[#062118]' : isRedSuit(suit) ? 'text-rose-400' : ''}>
                {SUIT_SYMBOLS[suit]}
              </span>
              {metrics.canHover && !compact && (
                <span className="text-[10px] font-mono-num opacity-75"> [{STRAIN_KEY_HINTS[suit]}]</span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          disabled={callRank === null}
          onClick={onConfirm}
          className={`flex-[1.6] ${buttonHeight} rounded-xl border border-amber-300 bg-amber-500 hover:bg-amber-400 text-[#062118] text-xs font-bold shadow-md transition cursor-pointer disabled:bg-[#0b3527]/60 disabled:text-emerald-200/40 disabled:border-amber-400/15 disabled:shadow-none disabled:cursor-not-allowed`}
        >
          {callRank !== null ? `确认 ${SUIT_SYMBOLS[callSuit]}${formatRank(callRank)}` : '先选点数'}
        </button>
      </div>

      {/* Ranks A..2 (own cards disabled) */}
      <div className="grid grid-cols-7 gap-1">
        {ALL_RANKS_DESC.map(rank => {
          const inOwnHand = myHand.some(c => c.suit === callSuit && c.rank === rank);
          const chosen = callRank === rank;
          return (
            <button
              key={rank}
              type="button"
              data-testid="call-rank"
              disabled={inOwnHand}
              onClick={() => onSelectRank(rank)}
              title={inOwnHand ? 'In your hand (cannot self-call)' : `Call ${SUIT_SYMBOLS[callSuit]}${formatRank(rank)}`}
              className={`${buttonHeight} rounded-lg border text-xs font-mono-num font-bold transition cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed ${
                chosen
                  ? 'bg-amber-500 text-[#062118] border-amber-300'
                  : 'border-amber-400/20 bg-[#0b3527]/90 hover:bg-[#124936] text-amber-100'
              }`}
            >
              {formatRank(rank)}
            </button>
          );
        })}
      </div>

      {metrics.canHover && !compact && (
        <div className="text-[10px] text-emerald-200/55 text-center">
          选好点数后点确认 · 键盘支持按 <span className="font-mono-num">S/H/C/D</span> 选花色、
          <span className="font-mono-num">A/K/Q/J/T/9-2</span> 选点数、<span className="font-mono-num">Enter</span> 确认
        </div>
      )}
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
  // Before the partner card is called there are no sides yet.
  const sidesKnown = gameState.partnerIndex !== null;
  const forfeiter =
    result.reason !== 'TRICKS' && Number.isInteger(result.forfeitingPlayerIndex)
      ? gameState.players[result.forfeitingPlayerIndex!]?.username
      : null;

  const roleBadge = (role: PlayerView['role']) => {
    if (role === 'LORD') return { label: '主公', cls: 'text-amber-300' };
    if (role === 'LOYALIST') return { label: '忠臣', cls: 'text-emerald-300' };
    if (role === 'REBEL') return { label: '反贼', cls: 'text-rose-300' };
    return null;
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
            {!sidesKnown ? '本局提前结束' : lordWon ? '主公 & 忠臣 获胜' : '反贼方 获胜'}
          </h2>
          {forfeiter && (
            <p className="text-xs text-rose-300">
              {forfeiter} {result.reason === 'TIMEOUT' ? '超时判负' : '认输'}
            </p>
          )}
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
                  {rb && <span className={`text-xs font-bold ${rb.cls}`}>[{rb.label}]</span>}
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
