// Bot-vs-bot balance check: node tools/simulate.mjs [games] [maxTurns] [slackPerWeariness]
import { readFileSync } from 'node:fs';
import {
  applyPool, applyToStack, attack, cardIssue, chooseMode, createGame, discardCard, eligibleStacks,
  endOrder, endTurn, fortification, getStack, isFace, legalAttacks, legalMerges, legalMoves,
  maxBonus, mergeStacks, moveStack, pairIssue, playCard, resolveHold, resolveRetreat, retreatOptions, strength,
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

const enemyOf = (state) => state.stacks.filter((s) => s.owner !== state.current);
const nearestEnemy = (state, hex) => Math.min(...enemyOf(state).map((e) => distance(hex, e)));
const isFront = (state, stack) => nearestEnemy(state, stack) <= 2;

// The defender of a pending battle stands if healthy, otherwise retreats when it can.
function decide(state) {
  const loser = getStack(state, state.pending.loserId);
  const options = retreatOptions(state);
  if (options.length > 0 && (state.elastic[loser.owner] || loser.men < 4)) {
    const home = state.capitals[loser.owner];
    const best = options.sort((a, b) => distance(a, home) - distance(b, home))[0];
    return resolveRetreat(state, best.col, best.row);
  }
  return resolveHold(state);
}

// The cheapest attack the order's points can turn into an upper hand. A weary nation also launches
// hopeless attacks (up to `slack` short), to bleed the enemy rather than sit still.
function bestAttack(state, slack) {
  let best = null;
  const cap = maxBonus(state);
  for (const stack of eligibleStacks(state)) {
    for (const target of legalAttacks(state, stack.id)) {
      const need = strength(state, target, true) - strength(state, stack, false) + 1;
      if (need > cap + slack) continue;
      const bonus = Math.min(Math.max(0, need), cap);
      const score = (need <= cap ? 100 : 0) - bonus * 10 - strength(state, target, true);
      if (!best || score > best.score) best = { stack, target, bonus, score };
    }
  }
  return best;
}

// One step of a pool card: spend points on the most useful menu entry, or null if nothing is worth it.
function poolStep(state) {
  const a = state.active;
  const owner = state.current;
  const menu = a.menu;
  const front = (s) => isFront(state, s);
  if (a.kind === 'defend') {
    for (const mode of ['trench', 'brace']) {
      if (a.points < menu[mode]) continue;
      const choosing = chooseMode(state, mode);
      const target = eligibleStacks(choosing)
        .filter(front)
        .sort((x, y) => fortification(state, x.col, x.row) - fortification(state, y.col, y.row) || y.men - x.men)[0];
      if (target) return applyToStack(choosing, target.id);
    }
    return null;
  }
  if (a.kind === 'logistics') {
    if (a.points >= menu.merge) {
      const merging = chooseMode(state, 'merge');
      for (const st of eligibleStacks(merging).sort((x, y) => x.men - y.men)) {
        const target = legalMerges(merging, st.id).find((t) => t.men + st.men <= 10);
        if (target && st.men <= 3) return mergeStacks(merging, st.id, target.id);
      }
    }
    if (a.points >= menu.rally) {
      const rallying = chooseMode(state, 'rally');
      const target = eligibleStacks(rallying).filter(front).sort((x, y) => y.men - x.men)[0];
      if (target) return applyToStack(rallying, target.id);
    }
    return null;
  }
  // Home front: relief when weary, a recruit when there is spare strength to add, otherwise propaganda.
  if (state.weariness[owner] > 0 && a.points >= menu.relief) return applyPool(state, 'relief');
  if (a.points >= menu.recruit) {
    const recruiting = chooseMode(state, 'recruit');
    const target = eligibleStacks(recruiting).filter(front).sort((x, y) => x.men - y.men)[0];
    if (target) return applyToStack(recruiting, target.id);
  }
  return a.points >= menu.propaganda ? applyPool(state, 'propaganda') : null;
}

// Use the active order sensibly; null if nothing is worthwhile.
function act(state) {
  if (state.active.kind === 'attack') {
    const pick = bestAttack(state, Math.floor(state.weariness[state.current] / SLACK_PER_WEARINESS));
    if (!pick) return null;
    const next = attack(state, pick.stack.id, pick.target.id, pick.bonus);
    return next.pending ? decide(next) : next;
  }
  return poolStep(state);
}

// Reserves walk toward the enemy (or its capital); trenched stacks only leave their trench when the hand holds an
// offensive card to follow the walk up with an attack.
function freeMoves(state) {
  const enemyCap = state.capitals[state.current === 'A' ? 'B' : 'A'];
  const offensive = state.hands[state.current].some((c) => c.suit === 'aggressive');
  for (const { id } of state.stacks.filter((s) => s.owner === state.current)) {
    for (let step = 0; step < state.move; step++) {
      const stack = getStack(state, id);
      if (fortification(state, stack.col, stack.row) > 0 && !(offensive && stack.men >= 3)) break;
      const goal = (hex) => (nearestEnemy(state, hex) <= 4 ? nearestEnemy(state, hex) : distance(hex, enemyCap));
      const best = legalMoves(state, id).sort((a, b) => goal(a) - goal(b))[0];
      if (!best || goal(best) >= goal(stack)) break;
      state = moveStack(state, id, best.col, best.row);
    }
  }
  return state;
}

const PRIORITY = ['aggressive', 'defensive', 'reorganizational', 'willingness'];

// Candidate plays: a pair of same-suit number cards (strongest first) or single cards by suit then rank.
function candidates(state) {
  const hand = state.hands[state.current];
  const singles = hand
    .filter((c) => cardIssue(state, c) === null)
    .sort((a, b) => PRIORITY.indexOf(a.suit) - PRIORITY.indexOf(b.suit) || b.rank - a.rank)
    .map((c) => [c.uid]);
  const pairs = [];
  if (state.played === 0) {
    for (const x of hand) {
      for (const y of hand) {
        if (x.uid < y.uid && x.suit === y.suit && !isFace(x.rank) && !isFace(y.rank) && pairIssue(state, x, y) === null) {
          pairs.push([x.uid, y.uid]);
        }
      }
    }
  }
  return [...pairs.filter(([u]) => state.hands[state.current].find((c) => c.uid === u).suit === 'aggressive'), ...singles];
}

function takeTurn(state) {
  state = freeMoves(state);
  let anyActed = false;
  for (let guard = 0; guard < 4 && state.played < state.cardsPerTurn && !state.over; guard++) {
    let acted = false;
    for (const uids of candidates(state)) {
      let current = playCard(state, ...uids);
      let did = !current.active;
      while (current.active && !current.over) {
        const next = act(current);
        if (!next) break;
        current = next;
        did = true;
      }
      if (current.active) current = endOrder(current);
      state = current;
      if (did) {
        acted = true;
        break;
      }
    }
    if (!acted) break;
    anyActed = true;
  }
  const hand = state.hands[state.current];
  // Nothing playable (or a dead card in hand): use the free discard so the deck keeps turning.
  const dead = hand.find((c) => /No stack/.test(cardIssue(state, c) ?? '')) ?? (anyActed ? null : hand[0]);
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
    log: state.log,
  });
}

// STATS=1 prints how often each kind of event occurred across all games.
if (process.env.STATS) {
  const kinds = ['moved', 'Trench built', 'digs in', 'rallies', 'merges', 'splits', 'rail', 'propaganda', 'relief',
    'recruit', 'retreats', 'stands', 'upper hand', 'repels', 'stalemate', 'advances'];
  const lines = results.flatMap((r) => r.log);
  console.log(Object.fromEntries(kinds.map((k) => [k, lines.filter((l) => l.includes(k)).length])));
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
