import React from 'react';
import type { Card } from '../types';
import { SUIT_SYMBOLS, formatRank, isRedSuit } from '../constants';

interface CardViewProps {
  card: Card;
  playable?: boolean;
  disabled?: boolean;
  winning?: boolean;
  size?: 'hand' | 'trick';
  onClick?: () => void;
}

export default function CardView({
  card,
  playable = false,
  disabled = false,
  winning = false,
  size = 'hand',
  onClick,
}: CardViewProps) {
  const red = isRedSuit(card.suit);
  const symbol = SUIT_SYMBOLS[card.suit];
  const rankStr = formatRank(card.rank);
  const textColor = red ? 'text-[#c92a2a]' : 'text-[#182230]';

  if (size === 'trick') {
    return (
      <div
        className={`w-[60px] h-[84px] sm:w-[70px] sm:h-[98px] md:w-[80px] md:h-[112px] rounded-xl playing-card-surface select-none flex flex-col justify-between p-1.5 sm:p-2 relative transition-transform duration-150 ${
          winning ? 'playing-card-winning scale-105' : ''
        }`}
      >
        {/* Top-left upright index */}
        <div className={`flex flex-col items-start leading-none ${textColor}`}>
          <span className="text-xs sm:text-sm md:text-base font-bold tracking-tighter font-mono-num">
            {rankStr}
          </span>
          <span className="text-xs sm:text-sm md:text-base leading-none mt-0.5">{symbol}</span>
        </div>

        {/* Center suit pip */}
        <div
          className={`absolute inset-0 flex items-center justify-center pointer-events-none ${textColor}`}
        >
          <span className="text-xl sm:text-2xl md:text-3xl opacity-90">{symbol}</span>
        </div>

        {/* Bottom-right upright index so regardless of which inner corner is overlapped in the 4-leaf clover, the outer corner is always upright and readable */}
        <div className={`flex flex-col items-end leading-none self-end ${textColor}`}>
          <span className="text-xs sm:text-sm md:text-base leading-none mb-0.5">{symbol}</span>
          <span className="text-xs sm:text-sm md:text-base font-bold tracking-tighter font-mono-num">
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
      className={`group relative flex-1 min-w-[40px] max-w-[78px] h-[68px] sm:h-[82px] md:h-[104px] lg:h-[116px] rounded-lg sm:rounded-xl playing-card-surface flex flex-col justify-between p-1.5 sm:p-2 md:p-2.5 transition-all duration-150 touch-manipulation ${
        playable
          ? 'cursor-pointer hover:-translate-y-2.5 active:translate-y-0 hover:ring-2 hover:ring-amber-400'
          : disabled
            ? 'opacity-45 saturate-75 cursor-not-allowed'
            : 'cursor-default'
      }`}
    >
      {/* Top-left rank & suit */}
      <div className={`flex flex-col items-start leading-none ${textColor}`}>
        <span className="text-xs sm:text-sm md:text-lg lg:text-xl font-bold tracking-tighter font-mono-num">
          {rankStr}
        </span>
        <span className="text-xs sm:text-sm md:text-base lg:text-lg leading-none mt-0.5">{symbol}</span>
      </div>

      {/* Bottom-right large suit emblem */}
      <div className={`self-end leading-none ${textColor}`}>
        <span className="text-base sm:text-xl md:text-2xl lg:text-3xl">{symbol}</span>
      </div>
    </button>
  );
}
