import React from 'react';
import { renderAvatarSVG } from '../utils/avatar';

interface AvatarProps {
  seed: number;
  size?: number;
  highlight?: boolean;
}

export default function Avatar({ seed, size = 36, highlight = false }: AvatarProps) {
  const svg = renderAvatarSVG(seed, size);
  return (
    <div
      className={`inline-block rounded-lg border transition-all flex-shrink-0 ${
        highlight
          ? 'border-amber-400 ring-2 ring-amber-400/40 shadow-md'
          : 'border-amber-200/30'
      }`}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
