import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import useGameStore from './store/gameStore';
import LoginScreen from './components/LoginScreen';
import WaitingRoom from './components/WaitingRoom';
import GameBoard from './components/GameBoard';
import ReplayBrowser from './replay/ReplayBrowser';
import ReplayViewer from './replay/ReplayViewer';

export default function App() {
  const { appPhase, connectionStatus, reconnectAttempts, toasts, removeToast } = useGameStore();

  return (
    <div className="game-shell overflow-hidden">
      {connectionStatus === 'reconnecting' && (
        <div className="fixed top-0 left-0 right-0 bg-amber-600/95 text-white text-center py-1 text-xs z-50 shadow-sm flex items-center justify-center gap-2">
          <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
          Reconnecting{reconnectAttempts > 0 ? ` (attempt ${reconnectAttempts})` : ''}...
        </div>
      )}
      {connectionStatus === 'error' && (
        <div className="fixed top-0 left-0 right-0 bg-rose-600/95 text-white text-center py-1 text-xs z-50 shadow-sm flex items-center justify-center gap-3">
          <span>Connection lost.</span>
          <button
            onClick={() => window.location.reload()}
            className="px-2.5 py-0.5 bg-white/20 hover:bg-white/30 rounded text-[11px] font-medium transition cursor-pointer"
          >
            Refresh
          </button>
        </div>
      )}
      {connectionStatus === 'entering_lobby' && (
        <div className="fixed top-0 left-0 right-0 bg-emerald-900/95 text-amber-100 text-center py-1 text-xs z-50 shadow-sm flex items-center justify-center gap-2">
          <span className="animate-spin h-3 w-3 border-2 border-amber-200 border-t-transparent rounded-full" />
          Connecting to lobby...
        </div>
      )}

      <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-1.5 pointer-events-none">
        <AnimatePresence>
          {toasts.map(toast => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: -16, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.92 }}
              transition={{ duration: 0.2 }}
              onClick={() => removeToast(toast.id)}
              className={`pointer-events-auto cursor-pointer px-4 py-1.5 rounded-xl shadow-lg text-xs font-medium border ${
                toast.type === 'error'
                  ? 'bg-rose-600/95 text-white border-rose-400/40'
                  : toast.type === 'warn'
                    ? 'bg-amber-600/95 text-white border-amber-400/40'
                    : 'bg-[#082d21]/95 text-amber-100 border-amber-400/30'
              }`}
            >
              {toast.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {appPhase === 'LOGIN' && <LoginScreen />}
      {appPhase === 'WAITING_ROOM' && <WaitingRoom />}
      {appPhase === 'GAME' && <GameBoard />}
      {appPhase === 'REPLAY_BROWSER' && <ReplayBrowser />}
      {appPhase === 'REPLAY_VIEWER' && <ReplayViewer />}
    </div>
  );
}
