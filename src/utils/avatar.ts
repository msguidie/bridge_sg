function seededRandom(seed: number) {
  let s = Math.abs(seed) || 1;
  return () => {
    s = ((s * 1103515245 + 12345) >>> 0) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const AVATAR_PALETTES = [
  { bg: '#f4efe6', fg: '#123e2f' },
  { bg: '#f4efe6', fg: '#7c2d12' },
  { bg: '#f4efe6', fg: '#1e3a5f' },
  { bg: '#f4efe6', fg: '#581c87' },
  { bg: '#f4efe6', fg: '#881337' },
];

export function renderAvatarSVG(seed: number, size: number = 40): string {
  const grid: boolean[][] = [];
  const rng = seededRandom(seed);
  const palette = AVATAR_PALETTES[Math.abs(seed) % AVATAR_PALETTES.length];

  for (let y = 0; y < 5; y++) {
    grid[y] = [];
    for (let x = 0; x < 3; x++) {
      const filled = rng() > 0.48;
      grid[y][x] = filled;
      grid[y][4 - x] = filled;
    }
  }

  const cellSize = size / 5;
  let rects = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      if (grid[y][x]) {
        rects += `<rect x="${x * cellSize}" y="${y * cellSize}" width="${cellSize}" height="${cellSize}" fill="${palette.fg}"/>`;
      }
    }
  }

  const r = size * 0.14;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${r}" fill="${palette.bg}"/>
    ${rects}
  </svg>`;
}
