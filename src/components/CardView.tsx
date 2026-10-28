import React from 'react';
import type { Card } from '../types';
import { SUIT_SYMBOLS, formatRank, isRedSuit } from '../constants';

interface CardViewProps {
  card: Card;
  width: number;
  height: number;
  variant?: 'hand' | 'trick' | 'mini';
  playable?: boolean;
  disabled?: boolean;
  winning?: boolean;
  selected?: boolean;
  onClick?: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// Sizes come from the table layout (viewport-driven), so every type scales with the card.
export default function CardView({
  card,
  width,
  height,
  variant = 'hand',
  playable = false,
  disabled = false,
  winning = false,
  selected = false,
  onClick,
}: CardViewProps) {
  const red = isRedSuit(card.suit);
  const symbol = SUIT_SYMBOLS[card.suit];
  const rankStr = formatRank(card.rank);
  const textColor = red ? 'text-[#c92a2a]' : 'text-[#182230]';
  const rankSize = clamp(height * 0.19, 10, 22);
  const pipSize = clamp(height * 0.16, 9, 18);
  const radius = clamp(height * 0.1, 4, 12);
  const pad = clamp(height * 0.07, 2, 9);

  if (variant === 'mini') {
    return (
      <div
        className={`playing-card-surface ring-1 ring-amber-400/80 flex flex-col items-center justify-center leading-none select-none ${textColor}`}
        style={{ width, height, borderRadius: clamp(height * 0.14, 3, 6) }}
      >
        <span className="font-mono-num font-bold tracking-tighter" style={{ fontSize: height * 0.4 }}>
          {rankStr}
        </span>
        <span style={{ fontSize: height * 0.36 }}>{symbol}</span>
      </div>
    );
  }

  if (variant === 'trick') {
    return (
      <div
        data-testid="trick-card"
        className={`playing-card-surface select-none flex flex-col justify-between relative transition-transform duration-150 ${
          winning ? 'playing-card-winning scale-105' : ''
        }`}
        style={{ width, height, padding: pad, borderRadius: radius }}
      >
        {/* Top-left upright index */}
        <div className={`flex flex-col items-start leading-none ${textColor}`}>
          <span className="font-bold tracking-tighter font-mono-num" style={{ fontSize: rankSize }}>
            {rankStr}
          </span>
          <span className="leading-none mt-0.5" style={{ fontSize: pipSize }}>
            {symbol}
          </span>
        </div>

        {/* Center suit pip */}
        <div
          className={`absolute inset-0 flex items-center justify-center pointer-events-none ${textColor}`}
        >
          <span className="opacity-90" style={{ fontSize: height * 0.28 }}>
            {symbol}
          </span>
        </div>

        {/* Bottom-right upright index so regardless of which inner corner is overlapped in the 4-leaf clover, the outer corner is always upright and readable */}
        <div className={`flex flex-col items-end leading-none self-end ${textColor}`}>
          <span className="leading-none mb-0.5" style={{ fontSize: pipSize }}>
            {symbol}
          </span>
          <span className="font-bold tracking-tighter font-mono-num" style={{ fontSize: rankSize }}>
            {rankStr}
          </span>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={!playable}
      onClick={playable ? onClick : undefined}
      aria-label={`Play ${rankStr} of ${symbol}`}
      data-selected={selected || undefined}
      className={`group relative playing-card-surface flex flex-col justify-between transition-all duration-150 touch-manipulation ${
        playable
          ? `cursor-pointer active:translate-y-0 ${selected ? 'ring-2 ring-amber-400' : 'hover:-translate-y-2.5 hover:ring-2 hover:ring-amber-400'}`
          : disabled
            ? 'opacity-45 saturate-75 cursor-not-allowed'
            : 'cursor-default'
      }`}
      style={{ width, height, padding: pad, borderRadius: radius }}
    >
      {/* Top-left rank & suit (the strip that stays visible when cards overlap) */}
      <div className={`flex flex-col items-start leading-none ${textColor}`}>
        <span className="font-bold tracking-tighter font-mono-num" style={{ fontSize: rankSize }}>
          {rankStr}
        </span>
        <span className="leading-none mt-0.5" style={{ fontSize: pipSize }}>
          {symbol}
        </span>
      </div>

      {/* Bottom-right large suit emblem */}
      <div className={`self-end leading-none ${textColor}`}>
        <span style={{ fontSize: clamp(height * 0.28, 14, 32) }}>{symbol}</span>
      </div>
    </button>
  );
}
