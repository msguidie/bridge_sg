import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import type {
  AppPhase,
  ConnectionStatus,
  GameState,
  LobbyPlayer,
  LobbyState,
  Account,
  ActionResult,
  ReplayData,
  ReplayIndexEntry,
} from '../types';
import { SERVER_URL, CONNECTION_CONFIG } from '../constants';
import { fetchReplay, fetchReplayList } from '../replay/replayApi';

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'warn' | 'error';
}

interface LobbyResponse {
  action: string;
  lobbyState?: LobbyState;
  error?: string;
}

interface GameStore {
  appPhase: AppPhase;
  connectionStatus: ConnectionStatus;
  socket: Socket | null;
  myAccount: Account | null;
  roomId: string | null;
  playerIndex: number;

  lobbyPlayers: LobbyPlayer[];
  lobbyUnlimitedTime: boolean;
  gameState: GameState | null;
  lastActionResult: ActionResult | null;
  reconnectAttempts: number;
  disconnectedPlayers: Set<string>;
  toasts: Toast[];

  // ── Replays ──
  replayList: ReplayIndexEntry[];
  replayListLoading: boolean;
  replayListError: string | null;
  currentReplay: ReplayData | null;
  replayLoading: boolean;
  replayError: string | null;

  connectToServer: () => Promise<void>;
  login: (username: string) => Promise<boolean>;
  refreshMyAccount: () => Promise<void>;
  enterLobby: () => void;
  leaveLobby: () => void;
  toggleReady: () => void;
  toggleGoFirst: () => void;
  toggleUnlimitedTime: () => void;
  sendAction: (action: Record<string, unknown>, onComplete?: (success: boolean) => void) => void;
  returnToLobby: () => void;
  quitRoom: () => void;
  resign: () => void;
  disconnect: () => void;
  addToast: (message: string, type?: Toast['type']) => void;
  removeToast: (id: string) => void;

  openReplayBrowser: () => void;
  refreshReplayList: () => Promise<void>;
  openReplay: (id: string) => Promise<void>;
  closeReplayViewer: () => void;
  closeReplayBrowser: () => void;
}

const useGameStore = create<GameStore>((set, get) => {
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let enterLobbyTimer: ReturnType<typeof setTimeout> | null = null;
  let replayListRequest = 0;
  let replayRequest = 0;

  function clearEnterLobbyTimer() {
    if (enterLobbyTimer === null) return;
    clearTimeout(enterLobbyTimer);
    enterLobbyTimer = null;
  }

  function showToast(message: string, type: Toast['type'] = 'info') {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    set(s => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
      set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
    }, 3800);
  }

  function applyLobbyState(lobbyState?: LobbyState) {
    if (!lobbyState) return;
    set({
      lobbyPlayers: lobbyState.players,
      lobbyUnlimitedTime: !!lobbyState.unlimitedTime,
    });
  }

  function handleLobbyResponse(result: LobbyResponse) {
    clearEnterLobbyTimer();
    if (result?.action === 'rejoin_game') return;
    if (result?.action === 'lobby_full' || result?.action === 'error') {
      showToast(result.error || 'Unable to enter the lobby', 'warn');
      set({ appPhase: 'LOGIN', connectionStatus: 'connected' });
      return;
    }
    applyLobbyState(result?.lobbyState);
    set({ appPhase: 'WAITING_ROOM', connectionStatus: 'in_lobby' });
  }

  function setupSocket(socket: Socket) {
    socket.on('lobby_update', (lobbyState: LobbyState) => {
      applyLobbyState(lobbyState);
      if (get().appPhase === 'LOGIN' && get().connectionStatus === 'entering_lobby') {
        clearEnterLobbyTimer();
        set({ appPhase: 'WAITING_ROOM', connectionStatus: 'in_lobby' });
      }
    });

    socket.on(
      'game_start',
      (data: {
        roomId: string;
        seatIndex?: number;
        playerIndex?: number;
        state: GameState;
        isReconnect?: boolean;
      }) => {
        clearEnterLobbyTimer();
        const idx = data.seatIndex ?? data.playerIndex ?? 0;
        set({
          appPhase: 'GAME',
          roomId: data.roomId,
          playerIndex: idx,
          gameState: data.state,
          disconnectedPlayers: new Set(),
          connectionStatus: 'connected',
          reconnectAttempts: 0,
        });
      },
    );

    socket.on(
      'game_state_update',
      (data: { state: GameState; lastAction?: ActionResult }) => {
        if (data?.state) {
          set({
            gameState: data.state,
            ...(data.lastAction ? { lastActionResult: data.lastAction } : {}),
          });
          if (data.state.phase === 'GAME_OVER') {
            void get().refreshMyAccount();
          }
        }
      },
    );

    socket.on('action_error', ({ message }: { message: string }) => {
      if (message) showToast(message, 'error');
    });

    socket.on('player_disconnected', ({ username }: { username: string }) => {
      set(s => ({ disconnectedPlayers: new Set([...s.disconnectedPlayers, username]) }));
      showToast(`${username} disconnected`, 'warn');
    });

    socket.on('player_reconnected', ({ username }: { username: string }) => {
      set(s => {
        const dp = new Set(s.disconnectedPlayers);
        dp.delete(username);
        return { disconnectedPlayers: dp };
      });
      showToast(`${username} reconnected`, 'info');
    });

    socket.on('room_closed', (data?: { reason?: string }) => {
      showToast(data?.reason || 'Room closed', 'warn');
      set({
        gameState: null,
        roomId: null,
        disconnectedPlayers: new Set(),
      });
      const sock = get().socket;
      if (sock && sock.connected) {
        sock.emit('enter_lobby', (result: LobbyResponse) => handleLobbyResponse(result));
      } else {
        set({ appPhase: 'LOGIN' });
      }
    });

    socket.on('disconnect', (reason: string) => {
      if (reason === 'io client disconnect') return;
      if (get().appPhase === 'GAME') {
        set({ connectionStatus: 'reconnecting' });
        attemptReconnect();
      } else {
        set({ connectionStatus: 'disconnected' });
      }
    });

    socket.on('pong_keep_alive', () => {});
  }

  function attemptReconnect() {
    const currentAttempts = get().reconnectAttempts;
    const myAccount = get().myAccount;
    if (currentAttempts >= CONNECTION_CONFIG.MAX_RECONNECT_ATTEMPTS) {
      set({ connectionStatus: 'error' });
      showToast('Reconnection failed. Please refresh.', 'error');
      return;
    }
    const delay = Math.min(
      CONNECTION_CONFIG.RECONNECT_DELAY_BASE * Math.pow(2, currentAttempts),
      CONNECTION_CONFIG.RECONNECT_DELAY_MAX,
    );
    setTimeout(async () => {
      set({ reconnectAttempts: currentAttempts + 1 });
      try {
        await get().connectToServer();
        const socket = get().socket;
        if (socket && myAccount) {
          socket.emit('login', { username: myAccount.username }, () => {
            socket.emit('enter_lobby', (result: LobbyResponse) => {
              if (result?.action === 'rejoin_game') {
                set({ connectionStatus: 'connected', reconnectAttempts: 0 });
                showToast('Reconnected to table!', 'info');
              } else {
                handleLobbyResponse(result);
              }
            });
          });
        }
      } catch {
        attemptReconnect();
      }
    }, delay);
  }

  return {
    appPhase: 'LOGIN',
    connectionStatus: 'idle',
    socket: null,
    myAccount: null,
    roomId: null,
    playerIndex: -1,
    lobbyPlayers: [],
    lobbyUnlimitedTime: false,
    gameState: null,
    lastActionResult: null,
    reconnectAttempts: 0,
    disconnectedPlayers: new Set(),
    toasts: [],
    replayList: [],
    replayListLoading: false,
    replayListError: null,
    currentReplay: null,
    replayLoading: false,
    replayError: null,

    connectToServer: async () => {
      const existingSocket = get().socket;
      if (existingSocket) {
        existingSocket.removeAllListeners();
        existingSocket.disconnect();
      }
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      set({ connectionStatus: 'connecting' });

      return new Promise<void>((resolve, reject) => {
        const socket = io(SERVER_URL, {
          transports: ['websocket', 'polling'],
          timeout: CONNECTION_CONFIG.CONNECTION_TIMEOUT,
          reconnection: false,
          forceNew: true,
        });

        const connectTimeout = setTimeout(() => {
          socket.disconnect();
          set({ connectionStatus: 'error' });
          reject(new Error('Connection timeout'));
        }, CONNECTION_CONFIG.CONNECTION_TIMEOUT);

        socket.on('connect', () => {
          clearTimeout(connectTimeout);
          set({ socket, connectionStatus: 'connected' });
          setupSocket(socket);

          const account = get().myAccount;
          if (account) {
            socket.emit('login', { username: account.username }, () => {});
          }

          heartbeatInterval = setInterval(
            () => socket.emit('ping_keep_alive'),
            CONNECTION_CONFIG.HEARTBEAT_INTERVAL,
          );
          resolve();
        });

        socket.on('connect_error', err => {
          clearTimeout(connectTimeout);
          set({ connectionStatus: 'error' });
          reject(err);
        });
      });
    },

    login: (username: string): Promise<boolean> => {
      return new Promise(resolve => {
        const { socket } = get();
        if (!socket) {
          resolve(false);
          return;
        }
        let settled = false;
        socket.emit(
          'login',
          { username },
          (result: { ok?: boolean; success?: boolean; account?: Account }) => {
            if (settled) return;
            settled = true;
            if ((result?.ok || result?.success) && result.account) {
              set({ myAccount: result.account });
              resolve(true);
            } else {
              resolve(false);
            }
          },
        );
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }, 5000);
      });
    },

    refreshMyAccount: async () => {
      const current = get().myAccount;
      if (!current) return;
      try {
        const res = await fetch(`${SERVER_URL}/api/accounts`);
        if (!res.ok) return;
        const list: Account[] = await res.json();
        const updated = list.find(a => a.username === current.username);
        if (updated) set({ myAccount: updated });
      } catch {
        // Ignore transient fetch errors
      }
    },

    enterLobby: () => {
      const { socket } = get();
      if (!socket) return;
      set({ connectionStatus: 'entering_lobby' });
      clearEnterLobbyTimer();
      enterLobbyTimer = setTimeout(() => {
        enterLobbyTimer = null;
        if (get().connectionStatus === 'entering_lobby' && get().appPhase === 'LOGIN') {
          set({ appPhase: 'WAITING_ROOM', connectionStatus: 'in_lobby' });
        }
      }, 3000);
      socket.emit('enter_lobby', (result: LobbyResponse) => {
        handleLobbyResponse(result);
      });
    },

    leaveLobby: () => {
      get().socket?.emit('leave_lobby');
      set({
        appPhase: 'LOGIN',
        connectionStatus: 'connected',
        lobbyPlayers: [],
        lobbyUnlimitedTime: false,
      });
      void get().refreshMyAccount();
    },

    toggleReady: () => {
      get().socket?.emit('toggle_ready');
    },

    toggleGoFirst: () => {
      get().socket?.emit('toggle_wants_first', (res: { error?: string }) => {
        if (res?.error) showToast(res.error, 'warn');
      });
    },

    toggleUnlimitedTime: () => {
      get().socket?.emit('toggle_unlimited_time', (res: { error?: string }) => {
        if (res?.error) showToast(res.error, 'warn');
      });
    },

    sendAction: (action: Record<string, unknown>, onComplete?: (success: boolean) => void) => {
      const { socket, roomId } = get();
      if (!socket || !roomId) {
        onComplete?.(false);
        return;
      }
      socket.emit('game_action', { roomId, action }, (res: { error?: string }) => {
        onComplete?.(!res?.error);
      });
    },

    returnToLobby: () => {
      const { socket, roomId } = get();
      set({
        gameState: null,
        roomId: null,
        disconnectedPlayers: new Set(),
      });
      void get().refreshMyAccount();
      if (socket && roomId) {
        socket.emit('return_to_lobby', { roomId }, () => {
          if (socket.connected) {
            socket.emit('enter_lobby', (result: LobbyResponse) => handleLobbyResponse(result));
          } else {
            set({ appPhase: 'LOGIN' });
          }
        });
      } else if (socket) {
        socket.emit('enter_lobby', (result: LobbyResponse) => handleLobbyResponse(result));
      } else {
        set({ appPhase: 'LOGIN' });
      }
    },

    quitRoom: () => {
      const { socket, roomId } = get();
      if (socket && roomId) socket.emit('quit_room', { roomId });
      set({
        gameState: null,
        roomId: null,
        disconnectedPlayers: new Set(),
      });
      if (socket) {
        socket.emit('enter_lobby', (result: LobbyResponse) => handleLobbyResponse(result));
      } else {
        set({ appPhase: 'LOGIN' });
      }
    },

    resign: () => {
      const { socket, roomId } = get();
      if (!socket || !roomId) return;
      socket.emit('resign_game', { roomId });
    },

    disconnect: () => {
      const { socket } = get();
      if (socket) socket.disconnect();
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      set({
        socket: null,
        connectionStatus: 'idle',
        appPhase: 'LOGIN',
        gameState: null,
        disconnectedPlayers: new Set(),
        toasts: [],
      });
    },

    addToast: (message, type = 'info') => showToast(message, type),
    removeToast: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

    openReplayBrowser: () => {
      set({ appPhase: 'REPLAY_BROWSER' });
      void get().refreshReplayList();
    },

    refreshReplayList: async () => {
      const token = ++replayListRequest;
      set({ replayListLoading: true, replayListError: null });
      try {
        const { games } = await fetchReplayList();
        if (token !== replayListRequest) return;
        set({ replayList: games, replayListLoading: false });
      } catch (err) {
        if (token !== replayListRequest) return;
        set({
          replayListLoading: false,
          replayListError: err instanceof Error ? err.message : 'Failed to load replays',
        });
      }
    },

    openReplay: async (id: string) => {
      const token = ++replayRequest;
      set({
        appPhase: 'REPLAY_VIEWER',
        currentReplay: null,
        replayLoading: true,
        replayError: null,
      });
      try {
        const replay = await fetchReplay(id);
        if (token !== replayRequest || get().appPhase !== 'REPLAY_VIEWER') return;
        set({ currentReplay: replay, replayLoading: false });
      } catch (err) {
        if (token !== replayRequest) return;
        set({
          replayLoading: false,
          replayError: err instanceof Error ? err.message : 'Failed to load this replay',
        });
      }
    },

    closeReplayViewer: () => {
      replayRequest++;
      set({
        appPhase: 'REPLAY_BROWSER',
        currentReplay: null,
        replayLoading: false,
        replayError: null,
      });
    },

    closeReplayBrowser: () => {
      set({ appPhase: 'LOGIN' });
    },
  };
});

export default useGameStore;
