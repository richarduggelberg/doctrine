// Bot-vs-bot balance check: node tools/simulate.mjs [games] [maxTurns] [slackPerExhaustion]
import { readFileSync } from 'node:fs';
import {
  applyPool, applyToStack, attack, cardIssue, chooseMode, createGame, discardCard, eligibleStacks,
  endOrder, endTurn, fortification, getStack, improvise, improviseIssue, isFace, legalAttacks, legalMerges, legalMoves,
  maxBonus, mergeStacks, moveStack, pairIssue, placeRecruit, playCard, recruitSites, resolveHold, resolveRetreat, retreatOptions, shell, shellCost,
  shellTargets, strength,
} from '../js/engine.js';
import { distance } from '../js/hex.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const map = read('../data/map.json');
const config = read('../data/cards.json');
// Tuning knobs for experiments: THRESH=n  MIRROR=1 gives both nations the doctrine of A.
if (process.env.THRESH) config.surrender.threshold = Number(process.env.THRESH);
// TURNTICK=n overrides the flat exhaustion each nation gains per turn; RELIEF=n the base relief of a Home Front card.
if (process.env.TURNTICK) config.surrender.turnTick = Number(process.env.TURNTICK);
if (process.env.RELIEF) config.orders.willingness.relief = Number(process.env.RELIEF);
// SUPPORT=perStack,max overrides the adjacent-stack defence bonus (0,0 turns it off).
if (process.env.SUPPORT) [config.support.perStack, config.support.max] = process.env.SUPPORT.split(',').map(Number);
if (process.env.MIRROR) config.doctrine.B = structuredClone(config.doctrine.A);
// TOWNW=small,big overrides the exhaustion a lost town costs each turn.
if (process.env.TOWNW) [config.surrender.townWeight, config.surrender.bigTownWeight] = process.env.TOWNW.split(',').map(Number);
// DOCB=aggressive:1,defensive:3,... overrides nation B's doctrine cards.
if (process.env.DOCB) {
  config.doctrine.B.cards = Object.fromEntries(process.env.DOCB.split(',').map((p) => [p.split(':')[0], Number(p.split(':')[1])]));
}
const games = Number(process.argv[2] ?? 300);
const maxTurns = Number(process.argv[3] ?? 80);
const SLACK_PER_EXHAUSTION = Number(process.argv[4] ?? 3);
// Orders a bot may play in one turn (the rules have no limit; the hand is the limit).
const MAX_ORDERS = Number(process.env.MAX_ORDERS ?? 8);

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
    for (const mode of ['trench']) {
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
  // Home front: relief when exhausted, otherwise a recruit when there is spare strength to add.
  if (state.exhaustion[owner] > 0 && a.points >= menu.relief) return applyPool(state, 'relief');
  if (a.points >= menu.recruit) {
    const recruiting = chooseMode(state, 'recruit');
    const target = eligibleStacks(recruiting).filter(front).sort((x, y) => x.men - y.men)[0];
    if (target) return applyToStack(recruiting, target.id);
  }
  return null;
}

// Use the active order sensibly; null if nothing is worthwhile.
function act(state) {
  if (state.active.kind === 'attack') {
    const pick = bestAttack(state, Math.floor(state.exhaustion[state.current] / SLACK_PER_EXHAUSTION));
    // Without a winning attack in reach, bombard the weakest-protected enemy first to soften it up.
    const targets = process.env.SHELL === '0' ? [] : shellTargets(state);
    if (targets.length && (!pick || pick.score < 100)) {
      const cheapest = targets.sort((a, b) => shellCost(state, a) - shellCost(state, b) || b.men - a.men)[0];
      return shell(state, cheapest.id);
    }
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
  for (const x of hand) {
    for (const y of hand) {
      if (x.uid < y.uid && x.suit === y.suit && !isFace(x.rank) && !isFace(y.rank) && pairIssue(state, x, y) === null) {
        pairs.push([x.uid, y.uid]);
      }
    }
  }
  return [...pairs.filter(([u]) => state.hands[state.current].find((c) => c.uid === u).suit === 'aggressive'), ...singles];
}

// Muster recruits in the empty home towns that sit about three hexes behind the enemy front.
function musterRecruits(state) {
  while (process.env.RECRUIT !== '0' && recruitSites(state).length) {
    const site = recruitSites(state).sort((a, b) => Math.abs(nearestEnemy(state, a) - 3) - Math.abs(nearestEnemy(state, b) - 3))[0];
    state = placeRecruit(state, site.col, site.row);
  }
  return state;
}

// Improvisations (IMPROVISE=0 turns them off): pairs of the same suit, from the suit held most, turned into any playable order.
function improvisations(state) {
  if (process.env.IMPROVISE === '0') return [];
  const hand = state.hands[state.current];
  const options = [];
  const suits = [...new Set(hand.map((c) => c.suit))]
    .sort((a, b) => hand.filter((c) => c.suit === b).length - hand.filter((c) => c.suit === a).length);
  for (const from of suits) {
    const [x, y] = hand.filter((c) => c.suit === from).sort((a, b) => a.rank - b.rank);
    if (!y) continue;
    for (const to of PRIORITY) if (improviseIssue(state, x, y, to) === null) options.push([x.uid, y.uid, to]);
  }
  return options;
}

function takeTurn(state) {
  state = freeMoves(musterRecruits(state));
  for (let guard = 0; guard < MAX_ORDERS && !state.over; guard++) {
    let acted = false;
    const opens = [
      ...candidates(state).map((uids) => (s) => playCard(s, ...uids)),
      ...improvisations(state).map((args) => (s) => improvise(s, ...args)),
    ];
    for (const open of opens) {
      let current = open(state);
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
  }
  const hand = state.hands[state.current];
  // Dead cards (no stack can use them) are thrown away to make room in the hand.
  for (const dead of hand.filter((c) => /No stack/.test(cardIssue(state, c) ?? ''))) {
    if (!state.over) state = discardCard(state, dead.uid);
  }
  return state;
}

const results = [];
for (let seed = 1; seed <= games; seed++) {
  let state = createGame(map, config, seed);
  while (!state.over && state.turn <= maxTurns) {
    state = takeTurn(state);
    if (state.over) break;
    state = endTurn(state);
  }
  results.push({
    winner: state.over?.winner ?? 'none',
    reason: state.over?.reason ?? 'turn limit',
    turns: state.turn,
    casualties: { ...state.casualties },
    exhaustion: { ...state.exhaustion },
    log: state.log,
  });
}

// STATS=1 prints how often each kind of event occurred across all games.
if (process.env.STATS) {
  const kinds = ['moved', 'Trench built', 'digs in', 'rallies', 'merges', 'splits', 'rail', 'relief',
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
console.log('avg exhaustion A/B:', avg(results.map((r) => r.exhaustion.A)), avg(results.map((r) => r.exhaustion.B)));
