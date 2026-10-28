import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Gauge, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
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
} from '../components/Table';
import type { SeatInfo } from '../components/Table';
import type { ReplayData, ReplayFrame, Strain, Suit } from '../types';
import { useReplayPlayer } from './useReplayPlayer';
import { STRAIN_SYMBOLS, SUIT_SYMBOLS, formatRank } from '../constants';

const ROLE_LABELS = { LORD: '主公', LOYALIST: '忠臣', REBEL: '反贼' } as const;
const NO_CARDS = new Set<number>();

function frameCaption(frame: ReplayFrame, names: string[]): string {
  if (!frame || frame.i === 0) return '发牌完毕 · 等待首家叫牌';
  const actorName = frame.actor !== null ? names[frame.actor] || `Seat ${frame.actor}` : '';
  const res = frame.result;
  if (!res) return '';

  const pl = (res.payload || {}) as Record<string, any>;
  switch (res.type) {
    case 'BID': {
      const level = pl.level;
      const strain = pl.strain as Strain;
      return `${actorName} 叫牌 ${level}${STRAIN_SYMBOLS[strain]}`;
    }
    case 'PASS':
      return pl.biddingEnded ? `${actorName} Pass · 叫牌结束` : `${actorName} Pass`;
    case 'CALL_CARD': {
      const c = pl.calledCard;
      return `${actorName} [主公] 指定队友牌 ${SUIT_SYMBOLS[c.suit as Suit]}${formatRank(c.rank)}`;
    }
    case 'PLAY_CARD': {
      const c = pl.card;
      return `${actorName} 出牌 ${SUIT_SYMBOLS[c.suit as Suit]}${formatRank(c.rank)}`;
    }
    case 'TRICK_RESOLVED':
      return `${actorName} 赢下本墩 (+1 墩)`;
    case 'RESIGN':
      return `${actorName} 投降认输`;
    case 'TIMEOUT':
      return `${actorName} 思考超时`;
    default:
      return '';
  }
}

// Watch from your own seat when you played in this game, otherwise from the Lord's.
function initialPerspective(replay: ReplayData, username?: string): number {
  const mine = replay.meta.players.findIndex(p => p.username === username);
  if (mine >= 0) return mine;
  const lord = replay.meta.result?.roles?.indexOf('LORD') ?? -1;
  return lord >= 0 ? lord : 0;
}

export default function ReplayViewer() {
  const { currentReplay, replayLoading, replayError, closeReplayViewer } = useGameStore();

  if (replayError) {
    return (
      <div className="game-shell mahjong-felt-bg mahjong-table-frame flex items-center justify-center p-4">
        <div className="bg-[#07241b]/92 rounded-2xl p-6 w-80 max-w-full text-center space-y-4 border border-amber-400/25 shadow-2xl">
          <h2 className="text-lg font-display font-bold text-amber-100">Replay Unavailable</h2>
          <p className="text-xs text-rose-400">{replayError}</p>
          <button
            onClick={closeReplayViewer}
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-[#062118] rounded-xl font-semibold transition text-xs cursor-pointer"
          >
            Back to Replays
          </button>
        </div>
      </div>
    );
  }

  if (replayLoading || !currentReplay || currentReplay.frames.length === 0) {
    return (
      <div className="game-shell mahjong-felt-bg mahjong-table-frame flex items-center justify-center p-4">
        <div className="text-center space-y-2">
          <span className="inline-block animate-spin h-5 w-5 border-2 border-amber-300 border-t-transparent rounded-full" />
          <p className="text-emerald-200/75 text-xs">Loading replay...</p>
        </div>
      </div>
    );
  }

  return <ReplayStage key={currentReplay.id} replay={currentReplay} onExit={closeReplayViewer} />;
}

function ReplayStage({ replay, onExit }: { replay: ReplayData; onExit: () => void }) {
  const myName = useGameStore(s => s.myAccount?.username);
  const metrics = useTableMetrics();
  const frames = replay.frames;
  const player = useReplayPlayer(frames.length, initialPerspective(replay, myName));
  const frame = frames[Math.min(player.index, frames.length - 1)];
  const gameState = frame.state;
  const perspective = Math.min(player.perspective, 3);
  const [overlayHidden, setOverlayHidden] = useState(false);

  useEffect(() => {
    if (gameState.phase !== 'GAME_OVER') setOverlayHidden(false);
  }, [gameState.phase]);

  const me = gameState.players[perspective];
  const leftIdx = (perspective + 1) % 4;
  const topIdx = (perspective + 2) % 4;
  const rightIdx = (perspective + 3) % 4;

  const isPlayingPhase = gameState.phase === 'PLAYING' || gameState.phase === 'GAME_OVER';
  const bidding = gameState.phase === 'BIDDING';
  const names = gameState.players.map(p => p.username);
  const caption = frameCaption(frame, names);
  const lastIndex = frames.length - 1;
  const standingBid = standingBidIndex(gameState.bidHistory);

  const seatInfo = (idx: number): SeatInfo => {
    const p = gameState.players[idx];
    const isLord = gameState.declarerIndex === idx;
    return {
      player: p,
      isTurn: gameState.currentPlayerIndex === idx && gameState.phase !== 'GAME_OVER',
      // Replays may show every role: the game is over.
      roleTag: p.role ? ROLE_LABELS[p.role] : isLord ? '主公' : null,
      calledCard: isLord ? gameState.calledCard : null,
      showAvatar: !isPlayingPhase,
      showTricks: isPlayingPhase,
      clock: null,
      offlineLabel: null,
      calls: seatCalls(gameState.bidHistory, idx),
      callPending: bidding && gameState.currentPlayerIndex === idx,
      highlightCall: standingBid,
      dimCalls: !bidding,
    };
  };
  const topInfo = seatInfo(topIdx);
  const selfInfo = seatInfo(perspective);

  // ── Playback controls (wrap onto a second line on narrow screens) ──
  const controlButton =
    'w-7 h-7 flex items-center justify-center rounded-lg bg-[#0b3527] hover:bg-[#124936] border border-amber-400/20 text-amber-100 disabled:opacity-35 cursor-pointer';
  const header = (
    <div className="w-full flex items-center gap-1.5 flex-wrap z-30 flex-shrink-0 mb-1">
      <button
        onClick={onExit}
        aria-label="Exit replay"
        className="px-2.5 h-7 flex items-center gap-1 rounded-lg bg-rose-950/70 hover:bg-rose-900 border border-rose-400/30 text-xs text-rose-200 cursor-pointer flex-shrink-0"
      >
        <X className="w-3.5 h-3.5" /> Exit
      </button>
      <span className="flex-1 min-w-[120px] text-xs text-amber-100/90 truncate">{caption}</span>
      <div className="flex items-center gap-1 flex-shrink-0">
        <span className="text-[11px] font-mono-num text-emerald-200/70 min-w-[3rem] text-right">
          {player.index}/{lastIndex}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(1, lastIndex)}
          value={player.index}
          onChange={e => player.seek(Number(e.target.value))}
          aria-label="Replay position"
          className="w-16 sm:w-28 h-1 accent-amber-400 cursor-pointer"
        />
        <button onClick={player.stepBack} disabled={player.index === 0} aria-label="Previous frame" className={controlButton}>
          <SkipBack className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={player.togglePlay}
          aria-label={player.playing ? 'Pause' : 'Play'}
          className="w-7 h-7 flex items-center justify-center rounded-lg bg-amber-500 hover:bg-amber-400 text-[#062118] font-bold cursor-pointer"
        >
          {player.playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
        <button onClick={player.stepForward} disabled={player.atEnd} aria-label="Next frame" className={controlButton}>
          <SkipForward className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={player.cycleSpeed}
          aria-label={`Playback speed ${player.speed}x`}
          className="px-2 h-7 flex items-center gap-1 rounded-lg bg-[#0b3527] hover:bg-[#124936] border border-amber-400/20 text-[11px] font-mono-num text-amber-100 cursor-pointer"
        >
          <Gauge className="w-3 h-3" />
          {player.speed}&times;
        </button>
      </div>

      {/* Perspective Switcher */}
      <div className="flex items-center gap-0.5 pl-1 border-l border-amber-400/20 flex-shrink-0">
        {gameState.players.map((p, idx) => (
          <button
            key={p.username}
            onClick={() => player.setPerspective(idx)}
            title={`Watch as ${p.username}`}
            className={`px-1.5 h-7 rounded text-[10px] font-semibold transition cursor-pointer ${
              idx === perspective
                ? 'bg-amber-500 text-[#062118]'
                : 'bg-[#0b3527]/70 text-emerald-200/70 hover:text-amber-100'
            }`}
          >
            {p.username.slice(0, 4)}
          </button>
        ))}
      </div>
    </div>
  );

  const center = isPlayingPhase ? (
    <TrickArea
      trick={gameState.currentTrick}
      trickNumber={gameState.trickNumber}
      viewerIndex={perspective}
      winningCardId={gameState.trickPendingResolve?.winningCardId ?? null}
      metrics={metrics}
    />
  ) : (
    <div className="bg-[#062219]/90 border border-amber-400/25 rounded-xl px-4 py-2 text-center space-y-1 shadow-xl max-w-full">
      <div className="text-xs font-semibold text-amber-200">
        {gameState.phase === 'BIDDING' ? '竞价叫牌阶段' : '主公点将阶段'}
      </div>
      <div className="text-xs text-emerald-200/80">{caption}</div>
    </div>
  );

  return (
    <TableLayout
      metrics={metrics}
      header={header}
      topLeft={<ContractBadge contract={gameState.contract} />}
      top={<Seat info={topInfo} side="top" metrics={metrics} />}
      left={<Seat info={seatInfo(leftIdx)} side="left" metrics={metrics} />}
      right={<Seat info={seatInfo(rightIdx)} side="right" metrics={metrics} />}
      center={center}
      self={<Seat info={selfInfo} side="self" metrics={metrics} />}
      hand={<HandRow cards={me.hand} metrics={metrics} playableIds={NO_CARDS} dimmedIds={NO_CARDS} />}
      insetTop={metrics.portrait ? 0 : callsOverhang(topInfo, metrics.bidRows.top, metrics)}
      insetBottom={callsOverhang(selfInfo, metrics.bidRows.self, metrics)}
    >
      {/* ── Game Over Overlay on Final Frame ── */}
      <AnimatePresence>
        {gameState.phase === 'GAME_OVER' && gameState.gameResult && !overlayHidden && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-3"
          >
            <motion.div
              initial={{ scale: 0.92 }}
              animate={{ scale: 1 }}
              className="relative bg-[#07241b] border border-amber-400/35 rounded-2xl p-5 max-w-md w-full space-y-3.5 shadow-2xl max-h-[calc(100dvh-1rem)] overflow-y-auto"
            >
              <button
                onClick={() => setOverlayHidden(true)}
                aria-label="Close summary"
                className="absolute top-3 right-3 text-emerald-200/60 hover:text-amber-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
              <div className="text-center space-y-1">
                <h2 className="text-xl font-display font-bold text-amber-300">
                  {gameState.partnerIndex === null
                    ? '本局提前结束'
                    : gameState.gameResult.winnerSide === 'LORD_WIN'
                      ? '主公 & 忠臣 获胜'
                      : '反贼方 获胜'}
                </h2>
                {gameState.contract && (
                  <p className="text-xs text-emerald-200/75 font-mono-num">
                    定约 {gameState.contract.level}
                    {STRAIN_SYMBOLS[gameState.contract.strain]} · 主忠{' '}
                    {gameState.gameResult.lordTricks}/{gameState.contract.lordTarget} 墩 · 反贼{' '}
                    {gameState.gameResult.rebelTricks}/{gameState.contract.rebelTarget} 墩
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                {gameState.players.map((p, idx) => {
                  const delta = gameState.gameResult?.ratingChanges[idx] ?? 0;
                  const roleLabel = p.role ? ROLE_LABELS[p.role] : null;
                  return (
                    <div
                      key={p.username}
                      className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-[#0a3124]/80 border border-amber-400/20 text-xs"
                    >
                      <div>
                        {roleLabel && <strong className="text-amber-300 mr-1.5">[{roleLabel}]</strong>}
                        <span className="text-amber-50">{p.username}</span>
                      </div>
                      <div className="font-mono-num flex items-center gap-3">
                        <span className="text-emerald-200/75">{p.tricksWon} 墩</span>
                        <span className={delta > 0 ? 'text-amber-300 font-bold' : 'text-rose-400 font-bold'}>
                          {delta > 0 ? `+${delta}` : delta}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button
                onClick={onExit}
                className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-[#062118] rounded-xl font-semibold transition text-xs cursor-pointer"
              >
                Exit Replay
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </TableLayout>
  );
}
