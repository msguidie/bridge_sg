import React, { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import useGameStore from '../store/gameStore';
import type { ReplayIndexEntry } from '../types';
import { STRAIN_SYMBOLS, SUIT_SYMBOLS, formatRank, isRedSuit } from '../constants';

function formatReplayDate(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startMs: number, endMs: number): string | null {
  if (!startMs || !endMs || endMs <= startMs) return null;
  const totalSec = Math.round((endMs - startMs) / 1000);
  if (totalSec < 60) return `${Math.max(1, totalSec)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export default function ReplayBrowser() {
  const {
    replayList,
    replayListLoading,
    replayListError,
    refreshReplayList,
    openReplay,
    closeReplayBrowser,
  } = useGameStore();

  useEffect(() => {
    if (replayList.length === 0 && !replayListLoading && !replayListError) {
      void refreshReplayList();
    }
  }, []);

  return (
    <div className="game-shell mahjong-felt-bg mahjong-table-frame flex items-center justify-center p-2 sm:p-4">
      <div className="bg-[#07241b]/92 rounded-2xl p-4 sm:p-6 w-[36rem] max-w-full space-y-3.5 border border-amber-400/25 shadow-2xl max-h-[calc(100dvh-1rem)] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between gap-3 flex-shrink-0">
          <h2 className="text-lg sm:text-xl font-display font-bold text-amber-100">Replays</h2>
          <button
            onClick={() => void refreshReplayList()}
            disabled={replayListLoading}
            className="px-3 py-1.5 flex items-center gap-1.5 bg-[#0b3527] hover:bg-[#124936] border border-amber-400/20 rounded-xl text-xs font-medium text-amber-100 transition disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${replayListLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5 max-h-[calc(100dvh-11rem)]">
          {replayListLoading && replayList.length === 0 && (
            <div className="py-8 text-center space-y-2">
              <span className="inline-block animate-spin h-5 w-5 border-2 border-amber-300 border-t-transparent rounded-full" />
              <p className="text-xs text-emerald-200/75">Loading replays...</p>
            </div>
          )}

          {!replayListLoading && replayListError && (
            <div className="py-6 text-center space-y-3">
              <p className="text-xs text-rose-400">{replayListError}</p>
              <button
                onClick={() => void refreshReplayList()}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-[#062118] rounded-xl text-xs font-semibold transition cursor-pointer"
              >
                Try again
              </button>
            </div>
          )}

          {!replayListLoading && !replayListError && replayList.length === 0 && (
            <p className="text-emerald-200/55 text-center text-xs py-8">
              No finished games recorded yet
            </p>
          )}

          {replayList.map(game => (
            <ReplayRow key={game.id} game={game} onOpen={() => void openReplay(game.id)} />
          ))}
        </div>

        <button
          onClick={closeReplayBrowser}
          className="w-full py-2 text-emerald-200/70 hover:text-amber-200 text-xs transition flex-shrink-0 cursor-pointer"
        >
          Back
        </button>
      </div>
    </div>
  );
}

function ReplayRow({ game, onOpen }: { game: ReplayIndexEntry; onOpen: () => void }) {
  const winners = new Set(game.winners || []);
  const contract = game.contract;
  const called = game.calledCard;
  const duration = formatDuration(game.t, game.e);

  const roleShort = (seat: number) => {
    const r = game.roles?.[seat];
    if (r === 'LORD') return '主';
    if (r === 'LOYALIST') return '忠';
    if (r === 'REBEL') return '反';
    return null;
  };

  return (
    <button
      onClick={onOpen}
      className="w-full text-left px-3.5 py-2.5 bg-[#0a3124]/80 hover:bg-[#114835] rounded-xl transition border border-amber-400/20 shadow-sm cursor-pointer space-y-1.5"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-emerald-200/65 text-[11px]">{formatReplayDate(game.t)}</span>
        <div className="flex items-center gap-2 font-mono-num">
          {contract && (
            <span className="text-amber-200 font-bold">
              {contract.level}
              <span className={isRedSuit(contract.strain) ? 'text-rose-400' : 'text-amber-100'}>
                {STRAIN_SYMBOLS[contract.strain]}
              </span>
            </span>
          )}
          {called && (
            <span className="text-emerald-200/75 text-[11px]">
              · 伴{' '}
              <strong className={isRedSuit(called.suit) ? 'text-rose-400' : 'text-amber-100'}>
                {SUIT_SYMBOLS[called.suit]}
                {formatRank(called.rank)}
              </strong>
            </span>
          )}
          <span className="text-amber-300 font-semibold text-[11px]">
            · {game.winnerSide === 'LORD_WIN' ? '主忠胜' : '反贼胜'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {game.players.map((name, seat) => {
          const won = winners.has(seat);
          const role = roleShort(seat);
          return (
            <span
              key={`${game.id}-${seat}`}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-xs ${
                won
                  ? 'bg-amber-500/20 border-amber-400/40 text-amber-200 font-semibold'
                  : 'bg-[#062118]/70 border-amber-400/10 text-emerald-100/75'
              }`}
            >
              <span>{won ? '★ ' : ''}{name}</span>
              {role && <span className="text-[10px] opacity-80">[{role}]</span>}
            </span>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-[10px] text-emerald-200/55 font-mono-num">
        <span>
          {game.turns} actions
          {duration ? ` · ${duration}` : ''}
        </span>
        {contract && (
          <span>
            主忠 {game.lordTricks}/{contract.lordTarget} 墩 · 反贼 {game.rebelTricks}/
            {contract.rebelTarget} 墩
          </span>
        )}
      </div>
    </button>
  );
}
