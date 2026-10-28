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

interface LoginResponse {
  ok?: boolean;
  success?: boolean;
  account?: Account;
  inGame?: boolean;
  error?: string;
}

// The username survives reloads (iOS often reloads a backgrounded tab) so a
// player lands back at the table without logging in again. The per-tab flag
// remembers whether this tab was in the lobby or a game.
const USERNAME_KEY = 'sgb.username';
const SEATED_KEY = 'sgb.seated';

function readStorage(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(store: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // Private mode or blocked storage: resuming just falls back to manual login.
  }
}

export const savedUsername = () => readStorage(() => localStorage, USERNAME_KEY);
const rememberUser = (name: string | null) => writeStorage(() => localStorage, USERNAME_KEY, name);
const wasSeated = () => readStorage(() => sessionStorage, SEATED_KEY) === '1';
const setSeated = (on: boolean) => writeStorage(() => sessionStorage, SEATED_KEY, on ? '1' : null);

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
  resumeSession: () => Promise<boolean>;
  switchAccount: () => void;
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
  addToast: (message: string, type?: Toast['type']) => void;
  removeToast: (id: string) => void;

  openReplayBrowser: () => void;
  refreshReplayList: () => Promise<void>;
  openReplay: (id: string) => Promise<void>;
  closeReplayViewer: () => void;
  closeReplayBrowser: () => void;
}

const useGameStore = create<GameStore>((set, get) => {
  let replayListRequest = 0;
  let replayRequest = 0;
  let lastRelogin = 0;

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

  // Requests are not queued while offline: socket.io would replay them before
  // we have logged in again. The player is told instead.
  function liveSocket(): Socket | null {
    const { socket } = get();
    if (socket?.connected) return socket;
    showToast('Connection lost, reconnecting...', 'warn');
    return null;
  }

  // Whether this tab should be back in the lobby/game after a reconnect.
  function seatedIntent() {
    const { appPhase, gameState } = get();
    if (appPhase === 'GAME' && gameState?.phase === 'GAME_OVER') return false; // keep the result screen
    return appPhase === 'GAME' || appPhase === 'WAITING_ROOM' || wasSeated();
  }

  function handleLobbyResponse(result?: LobbyResponse) {
    if (result?.action === 'rejoin_game') return;
    const account = get().myAccount;
    if (result?.action === 'error' && result.error === 'Login required' && account) {
      // The server restarted and forgot this socket: log in again (once, not in a loop).
      if (Date.now() - lastRelogin > 5000) {
        lastRelogin = Date.now();
        void identify(account.username, true);
        return;
      }
    }
    if (result?.action === 'lobby_full' || result?.action === 'error') {
      setSeated(false);
      showToast(result.error || 'Unable to enter the lobby', 'warn');
      set({ appPhase: 'LOGIN', connectionStatus: 'connected' });
      return;
    }
    applyLobbyState(result?.lobbyState);
    set({ appPhase: 'WAITING_ROOM', connectionStatus: 'in_lobby' });
  }

  function requestLogin(socket: Socket, username: string): Promise<LoginResponse | null> {
    return new Promise(resolve => {
      socket
        .timeout(CONNECTION_CONFIG.ACK_TIMEOUT)
        .emit('login', { username }, (err: Error | null, res: LoginResponse) => resolve(err ? null : res));
    });
  }

  // Logs in as `username` (after every reconnect too) and, when asked to or
  // when the server says we have a game running, goes back to the lobby/table.
  async function identify(username: string, enterAfter: boolean): Promise<boolean> {
    const { socket } = get();
    if (!socket?.connected) return false;
    const res = await requestLogin(socket, username);
    if (!res) return false; // no answer; the next reconnect tries again
    if (!(res.ok || res.success) || !res.account) {
      if (res.error === 'Account not found') {
        rememberUser(null);
        setSeated(false);
        set({ myAccount: null, appPhase: 'LOGIN', gameState: null, roomId: null });
        showToast(`Account "${username}" no longer exists. Please create it again.`, 'warn');
      }
      return false;
    }
    set({ myAccount: res.account });
    rememberUser(res.account.username);
    if (res.inGame || enterAfter) get().enterLobby();
    return true;
  }

  function bindSocket(socket: Socket) {
    socket.on('connect', () => {
      const { appPhase, myAccount } = get();
      set({
        connectionStatus: appPhase === 'WAITING_ROOM' ? 'in_lobby' : 'connected',
        reconnectAttempts: 0,
      });
      if (myAccount) void identify(myAccount.username, seatedIntent());
    });

    socket.on('disconnect', (reason: string) => {
      if (reason === 'io client disconnect') return;
      set({ connectionStatus: 'reconnecting' });
      if (reason === 'io server disconnect') socket.connect(); // socket.io does not retry this one
    });

    socket.io.on('reconnect_attempt', (attempt: number) => set({ reconnectAttempts: attempt }));

    socket.on('lobby_update', (lobbyState: LobbyState) => {
      applyLobbyState(lobbyState);
      if (get().appPhase === 'LOGIN' && get().connectionStatus === 'entering_lobby') {
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
        setSeated(true);
        const idx = data.seatIndex ?? data.playerIndex ?? 0;
        set({
          appPhase: 'GAME',
          roomId: data.roomId,
          playerIndex: idx,
          gameState: data.state,
          connectionStatus: 'connected',
          reconnectAttempts: 0,
        });
      },
    );

    socket.on(
      'game_state_update',
      (data: { roomId?: string; state: GameState; lastAction?: ActionResult }) => {
        if (!data?.state) return;
        const { roomId } = get();
        if (data.roomId && roomId && data.roomId !== roomId) return; // an older table
        set({
          gameState: data.state,
          ...(data.lastAction ? { lastActionResult: data.lastAction } : {}),
        });
        if (data.state.phase === 'GAME_OVER') {
          void get().refreshMyAccount();
        }
      },
    );

    socket.on('action_error', ({ message }: { message: string }) => {
      if (message) showToast(message, 'error');
    });

    socket.on('player_disconnected', ({ username }: { username: string }) => {
      showToast(`${username} disconnected`, 'warn');
    });

    socket.on('player_reconnected', ({ username }: { username: string }) => {
      showToast(`${username} reconnected`, 'info');
    });

    socket.on('room_closed', (data?: { reason?: string }) => {
      showToast(data?.reason || 'Room closed', 'warn');
      set({ gameState: null, roomId: null });
      get().enterLobby();
    });
  }

  // Back from the background or the network came back: retry now instead of
  // waiting out the backoff, and catch half-open connections after a sleep.
  function probeConnection() {
    const { socket } = get();
    if (!socket) return;
    if (!socket.connected) {
      set({ connectionStatus: 'reconnecting' });
      socket.disconnect().connect();
      return;
    }
    socket.timeout(CONNECTION_CONFIG.PROBE_TIMEOUT).emit('ping_check', (err: Error | null) => {
      if (!err) return;
      set({ connectionStatus: 'reconnecting' });
      socket.disconnect().connect();
    });
  }

  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') probeConnection();
    });
    window.addEventListener('online', probeConnection);
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
    toasts: [],
    replayList: [],
    replayListLoading: false,
    replayListError: null,
    currentReplay: null,
    replayLoading: false,
    replayError: null,

    // One socket for the whole session; socket.io keeps reconnecting it with
    // backoff and the 'connect' handler logs back in each time.
    connectToServer: () => {
      const existing = get().socket;
      if (existing?.connected) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const socket =
          existing ??
          io(SERVER_URL, {
            transports: ['websocket', 'polling'],
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
          });
        if (!existing) {
          bindSocket(socket);
          set({ socket });
        }
        set({ connectionStatus: 'connecting' });
        const onConnect = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          socket.off('connect', onConnect);
          if (!socket.connected) set({ connectionStatus: 'error' });
          reject(new Error('Connection timeout'));
        }, CONNECTION_CONFIG.CONNECTION_TIMEOUT);
        socket.once('connect', onConnect);
        if (!socket.active) socket.connect();
      });
    },

    login: (username: string) => identify(username, true),

    resumeSession: async () => {
      const name = savedUsername();
      if (!name || get().myAccount) return false;
      return identify(name, wasSeated());
    },

    switchAccount: () => {
      const { socket, appPhase } = get();
      if (appPhase === 'WAITING_ROOM' && socket?.connected) socket.emit('leave_lobby');
      rememberUser(null);
      setSeated(false);
      set({ myAccount: null, appPhase: 'LOGIN', lobbyPlayers: [], lobbyUnlimitedTime: false });
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
      setSeated(true);
      const { socket } = get();
      if (!socket) return;
      if (!socket.connected) {
        // The connect handler re-enters once the socket is back and logged in.
        set({ connectionStatus: 'reconnecting' });
        return;
      }
      set({ connectionStatus: 'entering_lobby' });
      socket
        .timeout(CONNECTION_CONFIG.ACK_TIMEOUT)
        .emit('enter_lobby', (err: Error | null, result: LobbyResponse) => {
          if (!err) {
            handleLobbyResponse(result);
            return;
          }
          if (get().connectionStatus === 'entering_lobby') {
            set({ connectionStatus: 'connected' });
            showToast('The lobby did not respond. Please try again.', 'warn');
          }
        });
    },

    leaveLobby: () => {
      setSeated(false);
      const { socket } = get();
      if (socket?.connected) socket.emit('leave_lobby');
      set({
        appPhase: 'LOGIN',
        lobbyPlayers: [],
        lobbyUnlimitedTime: false,
        ...(socket?.connected ? { connectionStatus: 'connected' as const } : {}),
      });
      void get().refreshMyAccount();
    },

    toggleReady: () => {
      liveSocket()?.emit('toggle_ready');
    },

    toggleGoFirst: () => {
      liveSocket()?.emit('toggle_wants_first', (res: { error?: string }) => {
        if (res?.error) showToast(res.error, 'warn');
      });
    },

    toggleUnlimitedTime: () => {
      liveSocket()?.emit('toggle_unlimited_time', (res: { error?: string }) => {
        if (res?.error) showToast(res.error, 'warn');
      });
    },

    sendAction: (action: Record<string, unknown>, onComplete?: (success: boolean) => void) => {
      const { roomId } = get();
      const socket = liveSocket();
      if (!socket || !roomId) {
        onComplete?.(false);
        return;
      }
      socket
        .timeout(CONNECTION_CONFIG.ACK_TIMEOUT)
        .emit('game_action', { roomId, action }, (err: Error | null, res: { error?: string }) => {
          onComplete?.(!err && !res?.error);
        });
    },

    returnToLobby: () => {
      const { socket, roomId } = get();
      set({ gameState: null, roomId: null });
      void get().refreshMyAccount();
      if (socket?.connected && roomId) socket.emit('return_to_lobby', { roomId });
      get().enterLobby();
    },

    quitRoom: () => {
      const { roomId } = get();
      const socket = liveSocket();
      if (!socket) return;
      if (roomId) socket.emit('quit_room', { roomId });
      set({ gameState: null, roomId: null });
      get().enterLobby();
    },

    resign: () => {
      const { roomId } = get();
      const socket = liveSocket();
      if (!socket || !roomId) return;
      socket.emit('resign_game', { roomId });
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
