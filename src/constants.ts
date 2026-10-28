import type { Suit, Strain } from './types';

// Uses VITE_SERVER_URL when deployed on Vercel; falls back to current origin for local/preview
export const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export const CONNECTION_CONFIG = {
  CONNECTION_TIMEOUT: 45000,
  HEALTH_CHECK_RETRY: 3000,
  MAX_HEALTH_CHECKS: 20,
  ACK_TIMEOUT: 8000,
  PROBE_TIMEOUT: 3000,
};

export const STRAIN_SYMBOLS: Record<Strain, string> = {
  0: '♣',
  1: '♦',
  2: '♥',
  3: '♠',
  4: 'NT',
};

export const STRAIN_NAMES: Record<Strain, string> = {
  0: 'Clubs',
  1: 'Diamonds',
  2: 'Hearts',
  3: 'Spades',
  4: 'No Trump',
};

export const STRAIN_KEY_HINTS: Record<Strain, string> = {
  0: 'C',
  1: 'D',
  2: 'H',
  3: 'S',
  4: 'N',
};

export const SUIT_SYMBOLS: Record<Suit, string> = {
  0: '♣',
  1: '♦',
  2: '♥',
  3: '♠',
};

export function isRedSuit(suitOrStrain: number): boolean {
  return suitOrStrain === 1 || suitOrStrain === 2;
}

export function formatRank(rank: number): string {
  switch (rank) {
    case 14:
      return 'A';
    case 13:
      return 'K';
    case 12:
      return 'Q';
    case 11:
      return 'J';
    default:
      return String(rank);
  }
}

export const ALL_RANKS_DESC = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2] as const;

export function parseKeyToStrain(key: string): Strain | null {
  switch (key.toLowerCase()) {
    case 'c':
      return 0;
    case 'd':
      return 1;
    case 'h':
      return 2;
    case 's':
      return 3;
    case 'n':
      return 4;
    default:
      return null;
  }
}

export function parseKeyToSuit(key: string): Suit | null {
  switch (key.toLowerCase()) {
    case 'c':
      return 0;
    case 'd':
      return 1;
    case 'h':
      return 2;
    case 's':
      return 3;
    default:
      return null;
  }
}

export function parseKeyToRank(key: string): number | null {
  const k = key.toLowerCase();
  if (k === 'a') return 14;
  if (k === 'k') return 13;
  if (k === 'q') return 12;
  if (k === 'j') return 11;
  if (k === 't' || k === '0') return 10;
  const num = Number(k);
  if (Number.isInteger(num) && num >= 2 && num <= 9) return num;
  return null;
}
