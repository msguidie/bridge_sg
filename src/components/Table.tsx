import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Avatar from './Avatar';
import CardView from './CardView';
import type { BidRecord, Card, Contract, CurrentTrick, PlayerView } from '../types';
import { STRAIN_SYMBOLS, isRedSuit } from '../constants';

// Shared by the live table (GameBoard) and the replay viewer.

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// ═══════════════════════════════════════════════════════════
// Viewport-driven sizing
// Width breakpoints hand a landscape phone (wide but short) desktop-sized
// cards, so every table size is derived from the real viewport instead.
// ═══════════════════════════════════════════════════════════

export interface TableMetrics {
  portrait: boolean;
  compact: boolean; // short landscape, i.e. a phone on its side
  handW: number;
  handH: number;
  trickW: number;
  trickH: number;
  chipW: number;
  chipH: number;
  bidRows: { top: number; side: number; self: number }; // calls per column before wrapping
  canHover: boolean; // has a mouse (and so, usually, a keyboard)
}

export function computeMetrics(width: number, height: number, canHover: boolean): TableMetrics {
  const portrait = height > width;
  const compact = !portrait && height < 520;
  const handH = Math.round(
    portrait ? clamp(Math.min(height * 0.13, width * 0.27), 64, 104) : clamp(height * 0.2, 56, 116),
  );
  const trickH = Math.round(
    portrait ? clamp(Math.min(height * 0.12, width * 0.24), 56, 104) : clamp(height * 0.17, 50, 112),
  );
  return {
    portrait,
    compact,
    handH,
    handW: Math.round(handH * 0.7),
    trickH,
    trickW: Math.round(trickH * 0.71),
    chipW: compact ? 30 : 34,
    chipH: compact ? 15 : 18,
    bidRows: portrait
      ? { top: 6, side: 6, self: 4 }
      : compact
        ? { top: 3, side: 5, self: 3 }
        : { top: 6, side: 8, self: 5 },
    canHover,
  };
}

function readViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useTableMetrics(): TableMetrics {
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const update = () => setViewport(readViewport());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return useMemo(
    () =>
      computeMetrics(
        viewport.width,
        viewport.height,
        window.matchMedia('(hover: hover) and (pointer: fine)').matches,
      ),
    [viewport.width, viewport.height],
  );
}

export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// ═══════════════════════════════════════════════════════════
// Seats: plaque (name, role, called card, tricks, clock) + that player's calls
// ═══════════════════════════════════════════════════════════

export interface SeatCall {
  record: BidRecord;
  index: number; // position in bidHistory
}

export function seatCalls(bidHistory: BidRecord[], seat: number): SeatCall[] {
  const calls: SeatCall[] = [];
  bidHistory.forEach((record, index) => {
    if (record.playerIndex === seat) calls.push({ record, index });
  });
  return calls;
}

// bidHistory index of the standing high bid, which is the contract once bidding ends.
export function standingBidIndex(bidHistory: BidRecord[]): number | null {
  for (let i = bidHistory.length - 1; i >= 0; i--) {
    if (bidHistory[i].type === 'BID') return i;
  }
  return null;
}

export interface SeatInfo {
  player: PlayerView;
  isTurn: boolean;
  roleTag: string | null; // 主公 / 忠臣 / 反贼
  calledCard: Card | null; // set on the Lord's seat for the rest of the game
  showAvatar: boolean;
  showTricks: boolean;
  clock: { label: string; urgent: boolean } | null;
  offlineLabel: string | null;
  calls: SeatCall[];
  callPending: boolean; // this seat calls next
  highlightCall: number | null;
  dimCalls: boolean;
}

function callCount(info: SeatInfo) {
  return info.calls.length + (info.callPending ? 1 : 0);
}

// How far a seat's calls stick out past its plaque (they are absolutely placed).
export function callsOverhang(info: SeatInfo, rows: number, metrics: TableMetrics) {
  const used = Math.min(rows, callCount(info));
  return Math.max(0, used * (metrics.chipH + 2) - (metrics.compact ? 28 : 36));
}

function BidChip({ record, highlight, compact }: { record: BidRecord; highlight: boolean; compact: boolean }) {
  const base = `flex items-center justify-center rounded-md border font-mono-num leading-none ${
    compact ? 'text-[10px]' : 'text-[11px]'
  }`;
  if (record.type === 'PASS') {
    return (
      <span className={`${base} border-amber-400/10 bg-[#051c14]/70 text-emerald-200/45`} style={{ direction: 'ltr' }}>
        Pass
      </span>
    );
  }
  const strain = record.strain ?? 4;
  return (
    <span
      className={`${base} font-bold ${
        highlight ? 'border-amber-300 bg-amber-400 text-[#062118]' : 'border-amber-400/25 bg-[#051c14]/85 text-amber-50'
      }`}
      style={{ direction: 'ltr' }}
    >
      {record.level}
      <span className={highlight ? '' : isRedSuit(strain) ? 'text-rose-400' : 'text-amber-100'}>
        {STRAIN_SYMBOLS[strain]}
      </span>
    </span>
  );
}

// One player's calls, round 1 on top; after `rows` rounds it continues in a new column.
function BidColumn({
  info,
  rows,
  metrics,
  reverse = false,
}: {
  info: SeatInfo;
  rows: number;
  metrics: TableMetrics;
  reverse?: boolean;
}) {
  const count = callCount(info);
  if (count === 0) return null;
  return (
    <div
      className={`grid gap-0.5 transition-opacity ${info.dimCalls ? 'opacity-70' : ''}`}
      style={{
        gridAutoFlow: 'column',
        gridTemplateRows: `repeat(${Math.min(rows, count)}, ${metrics.chipH}px)`,
        gridAutoColumns: `${metrics.chipW}px`,
        direction: reverse ? 'rtl' : 'ltr',
      }}
    >
      {info.calls.map(({ record, index }) => (
        <BidChip key={index} record={record} highlight={index === info.highlightCall} compact={metrics.compact} />
      ))}
      {info.callPending && (
        <span className="rounded-md border border-dashed border-amber-400/60 animate-pulse" aria-label="叫牌中" />
      )}
    </div>
  );
}

function SeatPlaque({
  info,
  variant,
  metrics,
}: {
  info: SeatInfo;
  variant: 'row' | 'stack';
  metrics: TableMetrics;
}) {
  const { player, isTurn, roleTag, calledCard, showAvatar, showTricks, clock, offlineLabel } = info;
  const c = metrics.compact;
  const nameMax = variant === 'stack' ? (metrics.portrait ? 64 : c ? 78 : 110) : c ? 96 : 130;

  const name = (
    <span
      className={`font-semibold truncate ${c ? 'text-[11px]' : 'text-xs sm:text-sm'} ${
        offlineLabel ? 'text-emerald-200/40 line-through' : 'text-amber-50'
      }`}
      style={{ maxWidth: nameMax }}
    >
      {player.username}
    </span>
  );
  const tag = roleTag && (
    <span
      className={`text-[10px] font-bold tracking-tight flex-shrink-0 ${
        roleTag === '忠臣' ? 'text-emerald-300' : roleTag === '反贼' ? 'text-rose-300' : 'text-amber-300'
      }`}
    >
      [{roleTag}]
    </span>
  );
  const tricks = showTricks && (
    <span className="flex items-baseline gap-0.5 font-mono-num flex-shrink-0">
      <span className={`${c ? 'text-xs' : 'text-sm sm:text-base'} font-bold text-amber-300`}>{player.tricksWon}</span>
      <span className="text-[10px] text-emerald-200/60">墩</span>
    </span>
  );
  const status = offlineLabel ? (
    <span className="text-[10px] font-mono-num font-bold text-rose-300 flex-shrink-0">{offlineLabel}</span>
  ) : clock ? (
    <span
      className={`${c ? 'text-[11px]' : 'text-xs'} font-mono-num flex-shrink-0 ${
        clock.urgent
          ? 'text-rose-400 font-bold animate-pulse'
          : isTurn
            ? 'text-amber-200 font-semibold'
            : 'text-emerald-200/55'
      }`}
    >
      {clock.label}
    </span>
  ) : null;
  const called = calledCard && (
    <span className="flex-shrink-0" title="主公叫的队友牌（忠臣牌）">
      <CardView card={calledCard} variant="mini" width={c ? 19 : 23} height={c ? 26 : 32} />
    </span>
  );
  const avatar = showAvatar && <Avatar seed={player.avatarSeed} size={c ? 20 : 26} highlight={isTurn} />;
  const shell = `inline-flex items-center rounded-xl border transition-all min-w-0 ${
    isTurn ? 'bg-[#104634]/95 border-amber-400 ring-2 ring-amber-400/35 shadow-lg' : 'bg-[#062118]/85 border-amber-400/20'
  } ${c ? 'gap-1.5 px-2 py-0.5' : 'gap-2 px-2.5 sm:px-3 py-1'}`;

  if (variant === 'stack') {
    return (
      <div className={shell} style={{ minHeight: c ? 34 : 42 }}>
        {avatar}
        <div className="flex flex-col justify-center min-w-0 leading-tight gap-0.5">
          <div className="flex items-center gap-1 min-w-0">
            {name}
            {tag}
          </div>
          {(tricks || status) && (
            <div className="flex items-center gap-1.5">
              {tricks}
              {status}
            </div>
          )}
        </div>
        {called}
      </div>
    );
  }

  const divider = 'pl-1.5 border-l border-amber-400/20 flex-shrink-0';
  return (
    <div className={shell} style={{ minHeight: c ? 28 : 36 }}>
      {avatar}
      {name}
      {tag}
      {called}
      {tricks && <span className={divider}>{tricks}</span>}
      {status && <span className={divider}>{status}</span>}
    </div>
  );
}

export function Seat({
  info,
  side,
  metrics,
}: {
  info: SeatInfo;
  side: 'top' | 'left' | 'right' | 'self';
  metrics: TableMetrics;
}) {
  const { portrait, bidRows, chipW } = metrics;

  if (portrait && side !== 'self') {
    // Opponents share the top row in portrait; their calls stack underneath.
    return (
      <div className="flex flex-col items-center gap-1 min-w-0 max-w-full">
        <SeatPlaque info={info} variant="stack" metrics={metrics} />
        <BidColumn info={info} rows={bidRows.side} metrics={metrics} />
      </div>
    );
  }

  if (side === 'left' || side === 'right') {
    // Calls hang from the plaque's top edge on the table side; the seat reserves
    // their width so they never slide under the center panel.
    const cols = Math.ceil(callCount(info) / bidRows.side);
    const reserve = cols > 0 ? cols * (chipW + 2) + 6 : 0;
    return (
      <div className="relative" style={side === 'left' ? { paddingRight: reserve } : { paddingLeft: reserve }}>
        <SeatPlaque info={info} variant="stack" metrics={metrics} />
        <div className="absolute top-0" style={side === 'left' ? { right: 0 } : { left: 0 }}>
          <BidColumn info={info} rows={bidRows.side} metrics={metrics} reverse={side === 'right'} />
        </div>
      </div>
    );
  }

  // Top (landscape) hangs its calls down beside the plaque; self grows them up
  // from the plaque's bottom edge. Either way round 1 stays on top.
  const rows = side === 'self' ? bidRows.self : bidRows.top;
  return (
    <div className="relative inline-flex max-w-full">
      <SeatPlaque info={info} variant="row" metrics={metrics} />
      <div className="absolute" style={{ left: 'calc(100% + 6px)', ...(side === 'self' ? { bottom: 0 } : { top: 0 }) }}>
        <BidColumn info={info} rows={rows} metrics={metrics} />
      </div>
    </div>
  );
}

export function ContractBadge({ contract }: { contract: Contract | null }) {
  if (!contract) return null;
  return (
    <div
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#051c14]/80 border border-amber-400/20 text-xs font-mono-num whitespace-nowrap"
      title={`主公方需 ${contract.lordTarget} 墩 · 反贼方需 ${contract.rebelTarget} 墩`}
    >
      <span className="text-amber-200 font-bold">
        {contract.level}
        <span className={isRedSuit(contract.strain) ? 'text-rose-400' : 'text-amber-100'}>
          {STRAIN_SYMBOLS[contract.strain]}
        </span>
      </span>
      <span className="text-emerald-200/70">目标 {contract.lordTarget} 墩</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Four-Leaf Clover (四叶草) Overlapping Trick Area
// Each card sits in its player's relative leaf quadrant (Top, Right, Bottom, Left),
// with later-played cards overlapping an inner corner of earlier-played cards via zIndex.
// Offsets are fractions of the card size so the clover scales with the table.
// ═══════════════════════════════════════════════════════════

const CLOVER_OFFSETS = [
  { x: 0.25, y: 0.34, rotate: -5 }, // Bottom (Self) — lower-right leaf
  { x: -0.6, y: 0.125, rotate: 6 }, // Left — lower-left leaf
  { x: -0.25, y: -0.34, rotate: -5 }, // Top — upper-left leaf
  { x: 0.6, y: -0.125, rotate: 6 }, // Right — upper-right leaf
];

export function TrickArea({
  trick,
  trickNumber,
  viewerIndex,
  winningCardId,
  metrics,
}: {
  trick: CurrentTrick;
  trickNumber: number;
  viewerIndex: number;
  winningCardId: number | null;
  metrics: TableMetrics;
}) {
  const { trickW, trickH } = metrics;
  const boxW = Math.round(trickW * 2.4 + 16);
  const boxH = Math.round(trickH * 1.75 + 12);
  const medallion = Math.round(Math.min(boxW, boxH) * 0.5);

  return (
    <div className="relative flex items-center justify-center select-none flex-shrink-0" style={{ width: boxW, height: boxH }}>
      {/* Subtle center mahjong table medallion */}
      <div
        className="rounded-full border border-amber-400/15 bg-[#07261c]/40 flex items-center justify-center pointer-events-none"
        style={{ width: medallion, height: medallion }}
      >
        <span className="text-[11px] font-mono-num text-emerald-200/40">第 {trickNumber} 墩</span>
      </div>

      <AnimatePresence>
        {trick.cards.map((entry, playOrder) => {
          const leaf = CLOVER_OFFSETS[(entry.playerIndex - viewerIndex + 4) % 4];
          const x = Math.round(leaf.x * trickW);
          const y = Math.round(leaf.y * trickH);
          const isWinning = winningCardId === entry.card.id;
          return (
            <motion.div
              key={`${trickNumber}-${entry.card.id}`}
              initial={{ opacity: 0, scale: 0.75, x: x * 2.2, y: y * 2.2, rotate: 0 }}
              animate={{ opacity: 1, scale: isWinning ? 1.06 : 1, x, y, rotate: leaf.rotate }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              style={{ zIndex: 20 + playOrder * 10 }}
              className="absolute"
            >
              <CardView card={entry.card} variant="trick" width={trickW} height={trickH} winning={isWinning} />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Hand: one row that spreads out when there is room and overlaps (showing the
// top-left index strip) when there is not, so no card is ever cut off.
// ═══════════════════════════════════════════════════════════

export function HandRow({
  cards,
  metrics,
  playableIds,
  dimmedIds,
  onPlay,
}: {
  cards: Card[];
  metrics: TableMetrics;
  playableIds: Set<number>;
  dimmedIds: Set<number>;
  onPlay?: (cardId: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const [selected, setSelected] = useState<number | null>(null);
  const { handW, handH } = metrics;
  const count = cards.length;
  const gap = Math.round(clamp(handW * 0.08, 3, 8));
  const natural = count * handW + Math.max(0, count - 1) * gap;
  const step = count > 1 && width > 0 && natural > width ? (width - handW) / (count - 1) : handW + gap;
  const overlapped = step < handW - 0.5;
  const raisedId = selected !== null && playableIds.has(selected) ? selected : null;

  useEffect(() => {
    if (playableIds.size === 0) setSelected(null);
  }, [playableIds.size]);

  useEffect(() => {
    if (selected === null) return;
    const clear = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setSelected(null);
    };
    document.addEventListener('pointerdown', clear);
    return () => document.removeEventListener('pointerdown', clear);
  }, [selected]);

  return (
    <div ref={ref} className="w-full flex justify-center" style={{ height: handH }}>
      <AnimatePresence initial={false}>
        {cards.map((card, i) => {
          const raised = raisedId === card.id;
          return (
            <motion.div
              key={card.id}
              layout
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: raised ? -Math.round(handH * 0.18) : 0 }}
              exit={{ opacity: 0, y: -24, scale: 0.85 }}
              transition={{ duration: 0.16 }}
              className="flex-shrink-0"
              style={{ width: handW, marginLeft: i === 0 ? 0 : step - handW }}
            >
              <CardView
                card={card}
                variant="hand"
                width={handW}
                height={handH}
                playable={playableIds.has(card.id)}
                disabled={dimmedIds.has(card.id)}
                selected={raised}
                onClick={() => {
                  // Overlapped cards are narrow targets: the first tap raises, the second plays.
                  if (overlapped && !raised) {
                    setSelected(card.id);
                    return;
                  }
                  setSelected(null);
                  onPlay?.(card.id);
                }}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Layout: landscape puts the side seats left/right of the center; portrait
// lines all three opponents up along the top and gives the center full width.
// ═══════════════════════════════════════════════════════════

export function TableLayout({
  metrics,
  header,
  topLeft,
  topRight,
  top,
  left,
  right,
  center,
  self,
  hand,
  insetTop = 0,
  insetBottom = 0,
  children,
}: {
  metrics: TableMetrics;
  header?: React.ReactNode;
  topLeft?: React.ReactNode;
  topRight?: React.ReactNode;
  top: React.ReactNode;
  left: React.ReactNode;
  right: React.ReactNode;
  center: React.ReactNode;
  self: React.ReactNode;
  hand: React.ReactNode;
  insetTop?: number;
  insetBottom?: number;
  children?: React.ReactNode;
}) {
  const shell = 'game-shell table-shell mahjong-felt-bg mahjong-table-frame relative overflow-hidden flex flex-col';

  if (metrics.portrait) {
    return (
      <div className={shell}>
        {header}
        <div className="flex items-center justify-between gap-2 z-20 flex-shrink-0 min-h-8">
          <div className="min-w-0">{topLeft}</div>
          <div className="flex items-center gap-1 flex-shrink-0">{topRight}</div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-1.5 z-10 flex-shrink-0 mt-1.5">
          <div className="min-w-0 flex justify-start">{left}</div>
          <div className="min-w-0 flex justify-center">{top}</div>
          <div className="min-w-0 flex justify-end">{right}</div>
        </div>
        <div
          className="flex-1 min-h-0 flex items-center justify-center relative my-1"
          style={{ paddingBottom: insetBottom }}
        >
          {center}
        </div>
        <div className="flex flex-col items-center gap-1.5 z-20 flex-shrink-0">
          {self}
          {hand}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className={`${shell} justify-between`}>
      {header}
      <div className="w-full flex items-start justify-between gap-2 z-20 flex-shrink-0">
        <div className="flex-1 basis-0 min-w-0 flex items-center">{topLeft}</div>
        <div className="flex justify-center">{top}</div>
        <div className="flex-1 basis-0 min-w-0 flex items-center justify-end gap-1">{topRight}</div>
      </div>
      <div className="flex-1 min-h-0 w-full flex items-center justify-between gap-2 my-1 relative">
        <div className="flex-shrink-0 z-10">{left}</div>
        <div
          className="flex-1 h-full min-w-0 flex items-center justify-center relative"
          style={{ paddingTop: insetTop, paddingBottom: insetBottom }}
        >
          {center}
        </div>
        <div className="flex-shrink-0 z-10">{right}</div>
      </div>
      <div className="w-full flex flex-col items-center gap-1.5 z-20 flex-shrink-0">
        {self}
        {hand}
      </div>
      {children}
    </div>
  );
}
