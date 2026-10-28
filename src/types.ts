export type Suit = 0 | 1 | 2 | 3; // 0: ♣, 1: ♦, 2: ♥, 3: ♠
export type Strain = 0 | 1 | 2 | 3 | 4; // 0: ♣, 1: ♦, 2: ♥, 3: ♠, 4: NT
export type PlayerRole = 'LORD' | 'LOYALIST' | 'REBEL' | null;

export interface Card {
  id: number;
  suit: Suit;
  rank: number; // 2..14 (11=J, 12=Q, 13=K, 14=A)
}

export interface BidRecord {
  playerIndex: number;
  type: 'BID' | 'PASS';
  level?: number;
  strain?: Strain;
}

export interface HighestBid {
  level: number;
  strain: Strain;
  bidderIndex: number;
}

export interface Contract {
  level: number;
  strain: Strain;
  declarerIndex: number;
  lordTarget: number;
  rebelTarget: number;
}

export interface TrickCardEntry {
  playerIndex: number;
  card: Card;
}

export interface CurrentTrick {
  leaderIndex: number | null;
  leadSuit: Suit | null;
  cards: TrickCardEntry[];
}

export interface TrickPendingResolve {
  winnerIndex: number;
  winningCardId: number;
  resolveAt: number;
}

export interface PlayerView {
  username: string;
  avatarSeed: number;
  hand: Card[];
  handCount: number;
  tricksWon: number;
  role: PlayerRole;
  connected?: boolean;
  disconnectDeadline?: number | null; // server time at which a disconnected seat forfeits
}

export interface TimeControlState {
  mainTimeMs: number;
  incrementMs: number;
  playerTimeRemainingMs: number[];
  activeSince: number | null;
  serverNow: number;
}

export interface GameResult {
  winnerSide: 'LORD_WIN' | 'REBEL_WIN';
  reason: 'TRICKS' | 'FORFEIT' | 'TIMEOUT';
  forfeitingPlayerIndex?: number | null;
  lordTricks: number;
  rebelTricks: number;
  ratingChanges: number[];
}

export interface GameState {
  phase: 'BIDDING' | 'CALL_PARTNER' | 'PLAYING' | 'GAME_OVER';
  numPlayers: number;
  currentPlayerIndex: number;
  firstBidderIndex: number;
  highestBid: HighestBid | null;
  consecutivePasses: number;
  bidHistory: BidRecord[];
  declarerIndex: number | null;
  partnerIndex: number | null;
  contract: Contract | null;
  calledCard: Card | null;
  trumpBroken: boolean;
  trickNumber: number;
  currentTrick: CurrentTrick;
  trickPendingResolve: TrickPendingResolve | null;
  lastCompletedTrick: {
    trickNumber: number;
    cards: TrickCardEntry[];
    winnerIndex: number;
    winningCardId: number;
  } | null;
  turnNumber: number;
  resignedPlayers: number[];
  gameResult: GameResult | null;
  legalCardIds: number[];
  players: PlayerView[];
  timeControl: TimeControlState | null;
  serverNow?: number; // live games: server clock at send time
}

export interface Account {
  username: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
  avatarSeed: number;
  createdAt?: number;
}

export type ConnectionStatus =
  | 'idle'
  | 'waking_server'
  | 'connecting'
  | 'connected'
  | 'entering_lobby'
  | 'in_lobby'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export type AppPhase =
  | 'LOGIN'
  | 'WAITING_ROOM'
  | 'GAME'
  | 'REPLAY_BROWSER'
  | 'REPLAY_VIEWER';

export interface LobbyPlayer {
  username: string;
  avatarSeed: number;
  ready: boolean;
  wantsFirst: boolean;
}

export interface LobbyState {
  players: LobbyPlayer[];
  unlimitedTime: boolean;
}

export interface ActionResult {
  type: string;
  actingPlayer: number;
  payload: Record<string, unknown>;
}

// ── Replays ──

export interface ReplayIndexEntry {
  id: string;
  t: number;
  e: number;
  players: string[];
  roles: PlayerRole[] | null;
  contract: Contract | null;
  calledCard: Card | null;
  winnerSide: 'LORD_WIN' | 'REBEL_WIN' | null;
  winners: number[];
  lordTricks: number;
  rebelTricks: number;
  turns: number;
}

export interface ReplayFrame {
  i: number;
  actor: number | null;
  action: Array<number | string> | null;
  result: ActionResult | null;
  state: GameState;
}

export interface ReplayData {
  id: string;
  meta: {
    t: number;
    e: number;
    clock: boolean;
    first: number;
    players: { username: string; avatarSeed: number }[];
    result: {
      winnerSide: 'LORD_WIN' | 'REBEL_WIN' | null;
      reason: 'TRICKS' | 'FORFEIT' | 'TIMEOUT' | null;
      lordTricks: number;
      rebelTricks: number;
      tricks: number[];
      roles: PlayerRole[];
      winners: number[];
      ratingChanges: number[];
      contract: Contract | null;
      calledCard: Card | null;
    } | null;
  };
  frames: ReplayFrame[];
}
