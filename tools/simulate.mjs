// Bot-vs-bot balance check: node tools/simulate.mjs [games] [maxTurns]
import { readFileSync } from 'node:fs';
import {
  applyToStack, attack, cardIssue, createGame, discardCard, eligibleStacks, endOrder, endTurn, getStack,
  legalAttacks, legalMerges, legalMoves, maxBonus, mergeStacks, moveStack, playCard, resolveHold,
  resolveRetreat, retreatOptions, strength,
} from '../js/engine.js';
import { distance } from '../js/hex.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const map = read('../data/map.json');
const config = read('../data/cards.json');
// Tuning knobs for experiments: THRESH=min,max  MIRROR=1 gives both nations the doctrine of A.
if (process.env.THRESH) [config.surrender.thresholdMin, config.surrender.thresholdMax] = process.env.THRESH.split(',').map(Number);
if (process.env.MIRROR) config.doctrine.B = structuredClone(config.doctrine.A);
// DOCB=aggressive:1,defensive:3,... overrides nation B's doctrine cards.
if (process.env.DOCB) {
  config.doctrine.B.cards = Object.fromEntries(process.env.DOCB.split(',').map((p) => [p.split(':')[0], Number(p.split(':')[1])]));
}
const games = Number(process.argv[2] ?? 300);
const maxTurns = Number(process.argv[3] ?? 80);
const SLACK_PER_WEARINESS = Number(process.argv[4] ?? 3);

// The defender of a pending battle stands if healthy, otherwise retreats when it can.
function decide(state) {
  const loser = getStack(state, state.pending.loserId);
  const options = retreatOptions(state);
  if (options.length > 0 && loser.men < 4) {
    const home = state.capitals[loser.owner];
    const best = options.sort((a, b) => distance(a, home) - distance(b, home))[0];
    return resolveRetreat(state, best.col, best.row);
  }
  return resolveHold(state);
}

// The cheapest attack the order's offensive points can turn into an upper hand. A weary nation
// also launches hopeless attacks (up to `slack` short), to bleed the enemy rather than sit still.
function bestAttack(state, slack) {
  let best = null;
  for (const stack of eligibleStacks(state)) {
    for (const target of legalAttacks(state, stack.id)) {
      const need = strength(state, target, true) - strength(state, stack, false) + 1;
      if (need > maxBonus(state) + slack) continue;
      const bonus = Math.min(Math.max(0, need), maxBonus(state));
      const score = -bonus * 10 - strength(state, target, true);
      if (!best || score > best.score) best = { stack, target, bonus, score };
    }
  }
  return best;
}

const touchesEnemy = (state, stack) =>
  legalAttacks({ ...state, active: { ...state.active, kind: 'attack', used: [] } }, stack.id).length > 0;

// Use the active order sensibly; null if nothing is worthwhile (the card is then refunded).
function act(state, kind) {
  const enemyCap = state.capitals[state.current === 'A' ? 'B' : 'A'];
  if (kind === 'attack' || kind === 'offensive') {
    const pick = bestAttack(state, Math.floor(state.weariness[state.current] / SLACK_PER_WEARINESS));
    if (!pick) return null;
    const next = attack(state, pick.stack.id, pick.target.id, pick.bonus);
    return next.pending ? decide(next) : next;
  }
  const stacks = eligibleStacks(state);
  if (kind === 'move') {
    const mover = stacks
      .filter((st) => !touchesEnemy(state, st))
      .sort((a, b) => distance(a, enemyCap) - distance(b, enemyCap))[0];
    if (!mover) return null;
    const hex = legalMoves(state, mover.id).sort((a, b) => distance(a, enemyCap) - distance(b, enemyCap))[0];
    return hex ? moveStack(state, mover.id, hex.col, hex.row) : null;
  }
  if (kind === 'merge') {
    for (const st of stacks) {
      const target = legalMerges(state, st.id).find((t) => t.men + st.men <= 10);
      if (target && st.men <= 3) return mergeStacks(state, st.id, target.id);
    }
    return null;
  }
  if (!stacks.length) return null;
  const pool = kind === 'entrench' || kind === 'hold' ? stacks.filter((st) => touchesEnemy(state, st)) : stacks;
  const target = (pool.length ? pool : stacks).sort((a, b) => b.men - a.men)[0];
  return applyToStack(state, target.id);
}

const PRIORITY = ['offensive', 'attack', 'entrench', 'rally', 'propaganda', 'posture', 'hold', 'merge', 'move'];

function takeTurn(state) {
  let anyActed = false;
  for (let play = 0; play < state.cardsPerTurn && !state.over; play++) {
    const hand = state.hands[state.current]
      .filter((c) => cardIssue(state, c) === null && PRIORITY.includes(state.defs[c.type].kind))
      .sort((a, b) => PRIORITY.indexOf(state.defs[a.type].kind) - PRIORITY.indexOf(state.defs[b.type].kind));
    let acted = false;
    for (const card of hand) {
      const played = playCard(state, card.uid);
      if (!played.active) {
        state = played;
        acted = true;
        break;
      }
      const after = act(played, state.defs[card.type].kind);
      if (!after) {
        state = endOrder(played);
        continue;
      }
      state = after;
      acted = true;
      break;
    }
    if (!acted) break;
    anyActed = true;
  }
  const hand = state.hands[state.current];
  // Nothing playable (or a dead card in hand): use the free discard so the deck keeps turning.
  const dead = hand.find((c) => ['split', 'martial'].includes(state.defs[c.type].kind)) ?? (anyActed ? null : hand[0]);
  if (dead && !state.discardUsed && !state.over) state = discardCard(state, dead.uid);
  return state;
}

const results = [];
for (let seed = 1; seed <= games; seed++) {
  let state = createGame(map, config, seed);
  let captures = 0;
  while (!state.over && state.turn <= maxTurns) {
    state = takeTurn(state);
    if (state.over) break;
    if (state.captured) captures += 1;
    state = endTurn(state);
  }
  results.push({
    winner: state.over?.winner ?? 'none',
    reason: state.over?.reason ?? 'turn limit',
    turns: state.turn,
    casualties: { ...state.casualties },
    captures,
  });
}

const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
const count = (f) => results.filter(f).length;
console.log(`${games} games, turn cap ${maxTurns}`);
console.log('winner A/B/none:', count((r) => r.winner === 'A'), count((r) => r.winner === 'B'), count((r) => r.winner === 'none'));
const reasons = {};
for (const r of results) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
console.log('reasons:', reasons);
console.log('avg turns:', avg(results.map((r) => r.turns)));
console.log('avg casualties A/B:', avg(results.map((r) => r.casualties.A)), avg(results.map((r) => r.casualties.B)));
console.log('avg capturing turns:', avg(results.map((r) => r.captures)));
