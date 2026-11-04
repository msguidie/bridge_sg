// Records random games played by the real server engine (server/gameLogic.js)
// into tests/fixtures/js_games.jsonl.gz.  At every step it stores the acting
// seat, the chosen action and the full legal-action set (found by trying all
// 140 action ids on a copy of the state), plus the final result, so the Python
// engine can be checked step by step (tests/test_engine_js.py).
//
//   node ai/scripts/gen_js_fixtures.mjs [games=300]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const gl = require(join(here, '..', '..', 'server', 'gameLogic.js'));

const PASS = 0, BID0 = 1, CALL0 = 36, PLAY0 = 88, NUM_ACTIONS = 140;

let seed = 20261104;
function rand() { // mulberry32: reproducible action choices
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function toJs(a) {
  if (a === PASS) return { type: 'PASS' };
  if (a < CALL0) {
    const k = a - BID0;
    return { type: 'BID', level: Math.floor(k / 5) + 1, strain: k % 5 };
  }
  if (a < PLAY0) {
    const c = a - CALL0;
    return { type: 'CALL_CARD', suit: Math.floor(c / 13), rank: (c % 13) + 2 };
  }
  return { type: 'PLAY_CARD', cardId: a - PLAY0 };
}

function legalActions(state) {
  const seat = state.currentPlayerIndex;
  const out = [];
  for (let a = 0; a < NUM_ACTIONS; a++) {
    if (!gl.processAction(structuredClone(state), seat, toJs(a)).error) out.push(a);
  }
  return out;
}

// Three bidding styles so contracts range from 1 to 7 (high ones end early for the Rebels).
const STYLES = [
  { pass: 0.7, jump: false },
  { pass: 0.6, jump: true },
  { pass: 0.85, jump: false },
];

function choose(state, legal, style) {
  if (state.phase === 'BIDDING') {
    const bids = legal.filter(a => a !== PASS);
    if (legal.includes(PASS) && (bids.length === 0 || rand() < style.pass)) return PASS;
    const pool = style.jump ? bids : bids.slice(0, 4);
    return pool[Math.floor(rand() * pool.length)];
  }
  return legal[Math.floor(rand() * legal.length)];
}

const N = Number(process.argv[2] || 300);
const lines = [];
const sides = {};
const levels = [0, 0, 0, 0, 0, 0, 0];
for (let g = 0; g < N; g++) {
  const style = STYLES[g % STYLES.length];
  const state = gl.createInitialGameState([0, 1, 2, 3].map(i => ({ username: `p${i}` })));
  const hands = state.players.map(p => p.hand.map(c => c.id));
  const first = state.firstBidderIndex;
  const steps = [];
  while (state.phase !== 'GAME_OVER') {
    const seat = state.currentPlayerIndex;
    const legal = legalActions(state);
    const a = choose(state, legal, style);
    const res = gl.processAction(state, seat, toJs(a));
    if (res.error) throw new Error(`game ${g}: ${res.error}`);
    steps.push([seat, a, legal]);
    if (state.trickPendingResolve) gl.resolvePendingTrick(state);
  }
  const side = state.gameResult.winnerSide;
  sides[side] = (sides[side] || 0) + 1;
  levels[state.contract.level - 1] += 1;
  lines.push(JSON.stringify({
    hands,
    first,
    steps,
    tricksWon: state.players.map(p => p.tricksWon),
    ratingChanges: state.gameResult.ratingChanges,
    declarer: state.declarerIndex,
    partner: state.partnerIndex,
    level: state.contract.level,
    strain: state.contract.strain,
    winnerSide: side,
  }));
}
const out = join(here, '..', 'tests', 'fixtures', 'js_games.jsonl.gz');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, gzipSync(lines.join('\n') + '\n'));
console.log(`wrote ${N} games to ${out}`, sides, 'contract levels 1..7:', levels);
