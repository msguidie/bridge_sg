import React, { useState, useEffect, useRef } from 'react';
import useGameStore from '../store/gameStore';
import { SERVER_URL, CONNECTION_CONFIG } from '../constants';
import Avatar from './Avatar';
import type { Account } from '../types';

export default function LoginScreen() {
  const { connectionStatus, myAccount, connectToServer, login, enterLobby, openReplayBrowser } =
    useGameStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [view, setView] = useState<'main' | 'create' | 'login'>('main');
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [wakeStatus, setWakeStatus] = useState('');
  const wakeAttempted = useRef(false);

  const connected = connectionStatus === 'connected' || connectionStatus === 'in_lobby';

  useEffect(() => {
    if (wakeAttempted.current) return;
    wakeAttempted.current = true;
    void wakeAndConnect();
  }, []);

  async function wakeAndConnect() {
    setLoading(true);
    setError('');
    setWakeStatus('Waking server...');

    let healthy = false;
    for (let i = 0; i < CONNECTION_CONFIG.MAX_HEALTH_CHECKS; i++) {
      try {
        const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // retry
      }
      setWakeStatus(`Waking server... (${i + 1}/${CONNECTION_CONFIG.MAX_HEALTH_CHECKS})`);
      await new Promise(r => setTimeout(r, CONNECTION_CONFIG.HEALTH_CHECK_RETRY));
    }

    if (!healthy) {
      setError('Server unreachable. Try again in a minute.');
      setWakeStatus('');
      setLoading(false);
      return;
    }

    setWakeStatus('Connecting...');
    try {
      await connectToServer();
      setWakeStatus('');
      await fetchAccounts();
    } catch {
      setError('Failed to connect. Try again.');
      setWakeStatus('');
    }
    setLoading(false);
  }

  async function fetchAccounts() {
    try {
      const res = await fetch(`${SERVER_URL}/api/accounts`);
      if (res.ok) {
        const data = await res.json();
        setAccounts(data);
      }
    } catch {
      // ignore
    }
  }

  async function createAccount() {
    if (!newName.trim()) return;
    setError('');
    try {
      const res = await fetch(`${SERVER_URL}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newName.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        const ok = await login(data.username);
        if (ok) {
          setView('main');
          setNewName('');
          enterLobby();
        } else {
          setError('Login failed after account creation');
        }
      } else {
        setError(data.error || 'Failed to create account');
      }
    } catch {
      setError('Network error');
    }
  }

  async function handleLogin(username: string) {
    setError('');
    const ok = await login(username);
    if (ok) enterLobby();
    else setError('Login failed');
  }

  useEffect(() => {
    if (connected && view === 'login') void fetchAccounts();
  }, [connected, view]);

  if (myAccount) {
    const scoreStr = myAccount.rating > 0 ? `+${myAccount.rating}` : `${myAccount.rating}`;
    return (
      <div className="game-shell mahjong-felt-bg mahjong-table-frame flex items-center justify-center p-3">
        <div className="bg-[#07241b]/90 rounded-2xl p-5 sm:p-7 w-80 max-w-full text-center space-y-3.5 border border-amber-400/25 shadow-2xl">
          <div className="flex justify-center">
            <Avatar seed={myAccount.avatarSeed} size={56} highlight />
          </div>
          <div>
            <h2 className="text-xl font-display font-bold text-amber-100">{myAccount.username}</h2>
            <p className="text-xs text-emerald-200/70 mt-1 font-mono-num">
              Score: <span className="text-amber-300 font-semibold">{scoreStr}</span> · Wins:{' '}
              {myAccount.wins} · Games: {myAccount.gamesPlayed}
            </p>
          </div>
          <button
            onClick={enterLobby}
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-[#062118] rounded-xl font-semibold transition shadow-md text-sm cursor-pointer"
          >
            Enter Lobby
          </button>
          <button
            onClick={openReplayBrowser}
            className="w-full py-2.5 bg-emerald-800/70 hover:bg-emerald-700/80 text-amber-100 border border-amber-400/20 rounded-xl font-semibold transition text-sm cursor-pointer"
          >
            Replays
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="game-shell mahjong-felt-bg mahjong-table-frame flex items-center justify-center p-3">
      <div className="bg-[#07241b]/90 rounded-2xl p-5 sm:p-7 w-84 max-w-full space-y-4 border border-amber-400/25 shadow-2xl">
        <div className="text-center space-y-1">
          <div className="flex justify-center gap-2 text-lg leading-none">
            <span className="text-amber-200">♠</span>
            <span className="text-rose-400">♥</span>
            <span className="text-amber-200">♣</span>
            <span className="text-rose-400">♦</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-tight text-amber-100">
            Singaporean Bridge
          </h1>
        </div>

        {!connected ? (
          <div className="space-y-3">
            {loading ? (
              <div className="text-center space-y-2 py-4">
                <span className="flex items-center justify-center gap-2">
                  <span className="animate-spin h-4 w-4 border-2 border-amber-300 border-t-transparent rounded-full" />
                  <span className="text-emerald-200/80 text-xs">{wakeStatus || 'Connecting...'}</span>
                </span>
              </div>
            ) : (
              <button
                onClick={() => void wakeAndConnect()}
                className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-[#062118] rounded-xl font-semibold transition shadow-md text-sm cursor-pointer"
              >
                Connect to Server
              </button>
            )}
            {error && <p className="text-rose-400 text-xs text-center">{error}</p>}
          </div>
        ) : view === 'main' ? (
          <div className="space-y-2.5">
            <button
              onClick={() => setView('create')}
              className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-[#062118] rounded-xl font-semibold transition shadow-md text-sm cursor-pointer"
            >
              Create Account
            </button>
            <button
              onClick={() => {
                setView('login');
                void fetchAccounts();
              }}
              className="w-full py-2.5 bg-emerald-800/70 hover:bg-emerald-700/80 text-amber-100 border border-amber-400/20 rounded-xl font-semibold transition text-sm cursor-pointer"
            >
              Login
            </button>
            <button
              onClick={openReplayBrowser}
              className="w-full py-2.5 bg-[#0b3527]/85 hover:bg-[#124936] text-amber-100 border border-amber-400/20 rounded-xl font-semibold transition text-sm cursor-pointer"
            >
              Replays
            </button>
          </div>
        ) : view === 'create' ? (
          <div className="space-y-2.5">
            <input
              type="text"
              placeholder="Enter username"
              value={newName}
              maxLength={16}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void createAccount()}
              className="w-full px-3.5 py-2 bg-[#051a13] border border-emerald-700/60 rounded-xl outline-none focus:ring-2 ring-amber-400/50 placeholder-emerald-200/40 text-amber-50 text-sm"
              autoFocus
            />
            <button
              onClick={() => void createAccount()}
              className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-[#062118] rounded-xl font-semibold transition shadow-md text-sm cursor-pointer"
            >
              Create
            </button>
            <button
              onClick={() => {
                setError('');
                setView('main');
              }}
              className="w-full py-1.5 text-emerald-200/60 hover:text-amber-200 text-xs cursor-pointer"
            >
              Back
            </button>
            {error && <p className="text-rose-400 text-xs text-center">{error}</p>}
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-xs text-emerald-200/70 text-center">Select account:</p>
            <div className="max-h-48 overflow-y-auto space-y-1.5 pr-0.5">
              {accounts.map(acc => {
                const scoreStr = acc.rating > 0 ? `+${acc.rating}` : `${acc.rating}`;
                return (
                  <button
                    key={acc.username}
                    onClick={() => void handleLogin(acc.username)}
                    className="w-full flex items-center gap-3 px-3 py-2 bg-[#0a3124]/80 hover:bg-[#114835] rounded-xl transition border border-amber-400/15 cursor-pointer"
                  >
                    <Avatar seed={acc.avatarSeed} size={30} />
                    <div className="text-left flex-1 min-w-0">
                      <div className="font-medium text-sm text-amber-100 truncate">{acc.username}</div>
                      <div className="text-[11px] text-emerald-200/60 font-mono-num">
                        Score: {scoreStr} · Wins: {acc.wins}
                      </div>
                    </div>
                  </button>
                );
              })}
              {accounts.length === 0 && (
                <p className="text-emerald-200/50 text-center text-xs py-4">No accounts yet</p>
              )}
            </div>
            <button
              onClick={() => {
                setError('');
                setView('main');
              }}
              className="w-full py-1.5 text-emerald-200/60 hover:text-amber-200 text-xs cursor-pointer"
            >
              Back
            </button>
            {error && <p className="text-rose-400 text-xs text-center">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
