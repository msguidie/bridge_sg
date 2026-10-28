import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Gauge, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import useGameStore from '../store/gameStore';
import Avatar from '../components/Avatar';
import CardView from '../components/CardView';
import type { ReplayData, ReplayFrame, PlayerView, Strain, Suit } from '../types';
import { useReplayPlayer } from './useReplayPlayer';
import { STRAIN_SYMBOLS, SUIT_SYMBOLS, formatRank, isRedSuit } from '../constants';

const CLOVER_OFFSETS: Record<number, { x: number; y: number; rotate: number }> = {
  0: { x: 20, y: 38, rotate: -5 },
  1: { x: -48, y: 14, rotate: 6 },
  2: { x: -20, y: -38, rotate: -5 },
  3: { x: 48, y: -14, rotate: 6 },
};

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
  const frames = replay.frames;
  const player = useReplayPlayer(frames.length, 4);
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
  const names = gameState.players.map(p => p.username);
  const caption = frameCaption(frame, names);
  const lastIndex = frames.length - 1;
  const trickCards = gameState.currentTrick.cards;
  const winningCardId = gameState.trickPendingResolve?.winningCardId ?? null;

  return (
    <div className="game-shell mahjong-felt-bg mahjong-table-frame flex flex-col justify-between relative overflow-hidden px-2 py-1.5 sm:px-4 sm:py-2.5">
      {/* ── Top Bar: Contract + Action Caption + Playback Controls ── */}
      <div className="w-full flex items-center justify-between gap-2 z-30 flex-shrink-0 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {gameState.contract && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#051c14]/85 border border-amber-400/20 text-xs font-mono-num flex-shrink-0">
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
          <span className="text-xs text-amber-100/90 truncate">{caption}</span>
        </div>

        {/* Top Seat (North) */}
        <ReplaySeatPlaque
          player={gameState.players[topIdx]}
          isCurrentTurn={gameState.currentPlayerIndex === topIdx && gameState.phase !== 'GAME_OVER'}
          isLord={gameState.declarerIndex === topIdx}
          showAvatar={!isPlayingPhase}
        />

        {/* Playback Controls */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-[11px] font-mono-num text-emerald-200/70">
            {player.index}/{lastIndex}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, lastIndex)}
            value={player.index}
            onChange={e => player.seek(Number(e.target.value))}
            aria-label="Replay position"
            className="w-20 sm:w-28 h-1 accent-amber-400 cursor-pointer"
          />
          <button
            onClick={player.stepBack}
            disabled={player.index === 0}
            aria-label="Previous frame"
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#0b3527] hover:bg-[#124936] border border-amber-400/20 text-amber-100 disabled:opacity-35 cursor-pointer"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={player.togglePlay}
            aria-label={player.playing ? 'Pause' : 'Play'}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-amber-500 hover:bg-amber-400 text-[#062118] font-bold cursor-pointer"
          >
            {player.playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={player.stepForward}
            disabled={player.atEnd}
            aria-label="Next frame"
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-[#0b3527] hover:bg-[#124936] border border-amber-400/20 text-amber-100 disabled:opacity-35 cursor-pointer"
          >
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

          {/* Perspective Switcher */}
          <div className="flex items-center gap-0.5 pl-1 border-l border-amber-400/20">
            {gameState.players.map((p, idx) => (
              <button
                key={p.username}
                onClick={() => player.setPerspective(idx)}
                title={`Watch as ${p.username}`}
                className={`px-1.5 py-1 rounded text-[10px] font-semibold transition cursor-pointer ${
                  idx === perspective
                    ? 'bg-amber-500 text-[#062118]'
                    : 'bg-[#0b3527]/70 text-emerald-200/70 hover:text-amber-100'
                }`}
              >
                {p.username.slice(0, 4)}
              </button>
            ))}
          </div>

          <button
            onClick={onExit}
            aria-label="Exit replay"
            className="px-2.5 h-7 flex items-center gap-1 rounded-lg bg-rose-950/70 hover:bg-rose-900 border border-rose-400/30 text-xs text-rose-200 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" /> Exit
          </button>
        </div>
      </div>

      {/* ── Middle Stage: Left Seat + Center 4-Leaf Clover + Right Seat ── */}
      <div className="flex-1 min-h-0 w-full flex items-center justify-between gap-2 my-1 relative">
        <ReplaySeatPlaque
          player={gameState.players[leftIdx]}
          isCurrentTurn={gameState.currentPlayerIndex === leftIdx && gameState.phase !== 'GAME_OVER'}
          isLord={gameState.declarerIndex === leftIdx}
          showAvatar={!isPlayingPhase}
        />

        <div className="flex-1 h-full flex items-center justify-center relative min-w-0">
          {!isPlayingPhase ? (
            <div className="bg-[#062219]/90 border border-amber-400/25 rounded-2xl px-5 py-3.5 text-center space-y-1.5 shadow-xl">
              <div className="text-xs font-semibold text-amber-200">
                {gameState.phase === 'BIDDING' ? '竞价叫牌阶段' : '主公点将阶段'}
              </div>
              <div className="text-xs text-emerald-200/80">{caption}</div>
            </div>
          ) : (
            <div className="relative w-56 h-40 sm:w-64 sm:h-48 md:w-72 md:h-52 flex items-center justify-center select-none">
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full border border-amber-400/15 bg-[#07261c]/40 flex items-center justify-center pointer-events-none">
                <span className="text-[11px] font-mono-num text-emerald-200/40">
                  第 {gameState.trickNumber} 墩
                </span>
              </div>
              <AnimatePresence>
                {trickCards.map((entry, playOrder) => {
                  const relSeat = (entry.playerIndex - perspective + 4) % 4;
                  const pos = CLOVER_OFFSETS[relSeat] || { x: 0, y: 0, rotate: 0 };
                  const isWinning = winningCardId === entry.card.id;
                  return (
                    <motion.div
                      key={`${gameState.trickNumber}-${entry.card.id}`}
                      initial={{ opacity: 0, scale: 0.8, x: pos.x * 1.8, y: pos.y * 1.8 }}
                      animate={{
                        opacity: 1,
                        scale: isWinning ? 1.06 : 1,
                        x: pos.x,
                        y: pos.y,
                        rotate: pos.rotate,
                      }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      transition={{ duration: 0.16 }}
                      style={{ zIndex: 20 + playOrder * 10 }}
                      className="absolute"
                    >
                      <CardView card={entry.card} size="trick" winning={isWinning} />
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>

        <ReplaySeatPlaque
          player={gameState.players[rightIdx]}
          isCurrentTurn={gameState.currentPlayerIndex === rightIdx && gameState.phase !== 'GAME_OVER'}
          isLord={gameState.declarerIndex === rightIdx}
          showAvatar={!isPlayingPhase}
        />
      </div>

      {/* ── Bottom Area: Watched Seat Plaque + Single-Row Hand ── */}
      <div className="w-full flex flex-col items-center gap-1.5 z-20 flex-shrink-0">
        <ReplaySeatPlaque
          player={me}
          isCurrentTurn={gameState.currentPlayerIndex === perspective && gameState.phase !== 'GAME_OVER'}
          isLord={gameState.declarerIndex === perspective}
          showAvatar={!isPlayingPhase}
        />

        <div className="w-full max-w-6xl flex items-center justify-center gap-1.5 sm:gap-2 md:gap-2.5 lg:gap-3 px-1.5 py-0.5 flex-nowrap">
          {me.hand.map(card => (
            <div key={card.id} className="flex-1 min-w-[40px] max-w-[78px] flex justify-center">
              <CardView card={card} size="hand" playable={false} />
            </div>
          ))}
        </div>
      </div>

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
              className="relative bg-[#07241b] border border-amber-400/35 rounded-2xl p-5 max-w-md w-full space-y-3.5 shadow-2xl"
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
                  {gameState.gameResult.winnerSide === 'LORD_WIN'
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
                  const roleLabel =
                    p.role === 'LORD' ? '主公' : p.role === 'LOYALIST' ? '忠臣' : '反贼';
                  return (
                    <div
                      key={p.username}
                      className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-[#0a3124]/80 border border-amber-400/20 text-xs"
                    >
                      <div>
                        <strong className="text-amber-300 mr-1.5">[{roleLabel}]</strong>
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
    </div>
  );
}

function ReplaySeatPlaque({
  player,
  isCurrentTurn,
  isLord,
  showAvatar,
}: {
  player: PlayerView;
  isCurrentTurn: boolean;
  isLord: boolean;
  showAvatar: boolean;
}) {
  const roleLabel =
    player.role === 'LORD'
      ? '主公'
      : player.role === 'LOYALIST'
        ? '忠臣'
        : player.role === 'REBEL'
          ? '反贼'
          : isLord
            ? '主公'
            : null;

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-xl border transition-all ${
        isCurrentTurn
          ? 'bg-[#104634]/95 border-amber-400 ring-2 ring-amber-400/35'
          : 'bg-[#062118]/80 border-amber-400/20'
      }`}
    >
      {showAvatar && <Avatar seed={player.avatarSeed} size={26} highlight={isCurrentTurn} />}
      <span className="text-xs sm:text-sm font-semibold text-amber-50 truncate max-w-[110px]">
        {player.username}
      </span>
      {roleLabel && (
        <span className="text-[10px] font-bold text-amber-300">[{roleLabel}]</span>
      )}
      {!showAvatar && (
        <span className="text-xs sm:text-sm font-bold text-amber-300 pl-1 border-l border-amber-400/20 font-mono-num">
          {player.tricksWon} <span className="text-[10px] font-normal text-emerald-200/60">墩</span>
        </span>
      )}
    </div>
  );
}
