import React from 'react';
import useGameStore from '../store/gameStore';
import Avatar from './Avatar';

export default function WaitingRoom() {
  const {
    lobbyPlayers,
    lobbyUnlimitedTime,
    myAccount,
    toggleReady,
    toggleGoFirst,
    toggleUnlimitedTime,
    leaveLobby,
  } = useGameStore();

  const me = lobbyPlayers.find(p => p.username === myAccount?.username);
  const allReady = lobbyPlayers.length === 4 && lobbyPlayers.every(p => p.ready);
  const waitingCount = lobbyPlayers.filter(p => !p.ready).length;

  return (
    <div className="game-shell mahjong-felt-bg mahjong-table-frame flex items-center justify-center p-2 sm:p-4">
      <div className="bg-[#07241b]/92 rounded-2xl p-4 sm:p-6 w-96 max-w-full space-y-3 sm:space-y-4 border border-amber-400/25 shadow-2xl max-h-[calc(100dvh-1rem)] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-display font-bold text-amber-100">Lobby</h2>
          <span className="text-xs font-mono-num text-emerald-200/70">
            {lobbyPlayers.length} / 4 players
          </span>
        </div>

        {/* I WANT TO GO FIRST switch */}
        <div className="flex items-center justify-between gap-3 rounded-xl bg-[#0b3527]/75 border border-amber-400/15 px-3.5 py-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-amber-100">I WANT TO GO FIRST</div>
            <div className="text-[10px] leading-tight text-emerald-200/60">
              Volunteers resolved randomly; first bidder must make an opening bid
            </div>
          </div>
          <Switch
            checked={!!me?.wantsFirst}
            onClick={toggleGoFirst}
            label="Toggle first-player preference"
          />
        </div>

        {/* Unlimited Time switch (default: 1.5 min + 10 sec) */}
        <div className="flex items-center justify-between gap-3 rounded-xl bg-[#0b3527]/75 border border-amber-400/15 px-3.5 py-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-amber-100">Unlimited Time</div>
            <div className="text-[10px] leading-tight text-emerald-200/60">
              Otherwise each player uses a 1.5 min + 10 sec clock (including bidding)
            </div>
          </div>
          <Switch
            checked={lobbyUnlimitedTime}
            onClick={toggleUnlimitedTime}
            label="Toggle unlimited time"
          />
        </div>

        {/* 4 Player slots */}
        <div className="space-y-1.5">
          {lobbyPlayers.map(p => (
            <div
              key={p.username}
              className={`flex items-center gap-3 px-3.5 py-2 rounded-xl transition border ${
                p.username === myAccount?.username
                  ? 'bg-[#114835]/90 border-amber-400/35'
                  : 'bg-[#0a3124]/65 border-amber-400/10'
              }`}
            >
              <Avatar seed={p.avatarSeed} size={32} highlight={p.ready} />
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm text-amber-50 truncate block">
                  {p.username}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {p.wantsFirst && (
                  <span className="text-[10px] font-semibold text-amber-300">First</span>
                )}
                <span
                  className={`text-xs font-medium ${
                    p.ready ? 'text-emerald-300' : 'text-emerald-200/45'
                  }`}
                >
                  {p.ready ? '✓ Ready' : 'Not Ready'}
                </span>
              </div>
            </div>
          ))}
          {lobbyPlayers.length === 0 && (
            <p className="text-emerald-200/50 text-center py-3 text-xs">Waiting for players...</p>
          )}
        </div>

        <div className="text-center min-h-[18px]">
          {allReady ? (
            <span className="text-amber-300 text-xs font-semibold animate-pulse">
              Starting game...
            </span>
          ) : lobbyPlayers.length < 4 ? (
            <span className="text-emerald-200/60 text-xs">
              Waiting for {4 - lobbyPlayers.length} more player{4 - lobbyPlayers.length > 1 ? 's' : ''} (strictly 4 players)
            </span>
          ) : waitingCount > 0 ? (
            <span className="text-emerald-200/60 text-xs">
              Waiting for {waitingCount} player{waitingCount > 1 ? 's' : ''} to ready up
            </span>
          ) : null}
        </div>

        {/* Stays in view when the card scrolls (phones on their side) */}
        <div className="flex gap-2 sticky -bottom-4 sm:-bottom-6 pt-2 pb-4 sm:pb-6 -mb-4 sm:-mb-6 bg-[#07241b]">
          <button
            onClick={leaveLobby}
            className="px-4 py-2.5 rounded-xl text-xs font-medium text-emerald-200/70 hover:text-amber-100 bg-[#0b3527]/70 border border-amber-400/15 transition cursor-pointer"
          >
            Leave Lobby
          </button>
          <button
            onClick={toggleReady}
            className={`flex-1 py-2.5 rounded-xl font-semibold transition text-sm shadow-md cursor-pointer ${
              me?.ready
                ? 'bg-emerald-800/80 hover:bg-emerald-700 text-amber-100 border border-amber-400/25'
                : 'bg-amber-500 hover:bg-amber-400 text-[#062118]'
            }`}
          >
            {me?.ready ? 'Cancel Ready' : 'Ready'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Switch({
  checked,
  onClick,
  label,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={onClick}
      className="w-11 h-7 flex-shrink-0 flex items-center justify-center cursor-pointer touch-manipulation"
    >
      <span
        className={`relative block w-10 h-5 rounded-full transition-colors ${
          checked ? 'bg-amber-500' : 'bg-emerald-950 border border-emerald-700/60'
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  );
}
