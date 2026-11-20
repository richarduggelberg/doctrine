// Bot-vs-bot balance check: node tools/simulate.mjs [games] [maxTurns] [slackPerWeariness]
import { readFileSync } from 'node:fs';
import {
  applyPool, applyToStack, attack, canPayEntry, cardIssue, chooseMode, createGame, discardCard, eligibleStacks,
  endOrder, endTurn, fortification, getStack, inEnemyZoc, legalAssaults, legalAttacks, legalMerges, legalMoves,
  maxBonus, mergeStacks, moveStack, playCard, resolveHold, resolveRetreat, retreatOptions, strength,
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

// The cheapest attack the order's points can turn into an upper hand, direct or by assault. A weary
// nation also launches hopeless attacks (up to `slack` short), to bleed the enemy rather than sit still.
function bestAttack(state, slack) {
  let best = null;
  const consider = (stack, target, entry, pay) => {
    if (pay && !canPayEntry(state)) return;
    const hasty = entry && !state.active.freeEntry && !pay ? state.assault.hastyPenalty : 0;
    const cap = maxBonus(state, Boolean(entry) && pay);
    const need = strength(state, target, true) - (strength(state, stack, false) - hasty) + 1;
    if (need > cap + slack) return;
    const bonus = Math.min(Math.max(0, need), cap);
    const spent = bonus + (pay ? state.assault.entryCost : 0);
    const score = (need <= cap ? 100 : 0) - spent * 10 - strength(state, target, true);
    if (!best || score > best.score) best = { stack, target, bonus, entry, pay, score };
  };
  for (const stack of eligibleStacks(state)) {
    for (const target of legalAttacks(state, stack.id)) consider(stack, target, null, false);
    for (const entry of legalAssaults(state, stack.id)) {
      for (const target of entry.targets) {
        consider(stack, target, { col: entry.col, row: entry.row }, false);
        consider(stack, target, { col: entry.col, row: entry.row }, true);
      }
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
  if (a.kind === 'fortify') {
    const target = eligibleStacks(state)
      .filter(front)
      .sort((x, y) => fortification(state, x.col, x.row) - fortification(state, y.col, y.row) || y.men - x.men)[0];
    return target ? applyToStack(state, target.id) : null;
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
  const kind = state.active.kind;
  if (kind === 'attack') {
    const pick = bestAttack(state, Math.floor(state.weariness[state.current] / SLACK_PER_WEARINESS));
    if (!pick) return null;
    const next = attack(state, pick.stack.id, pick.target.id, pick.bonus, pick.entry, pick.pay);
    return next.pending ? decide(next) : next;
  }
  if (kind === 'hold') {
    const target = eligibleStacks(state).filter((s) => inEnemyZoc(state, state.current, s.col, s.row) || isFront(state, s))[0];
    return target ? applyToStack(state, target.id) : null;
  }
  return poolStep(state);
}

// Reserves without a trench walk toward the enemy (or its capital) whenever the way is outside enemy zones.
function freeMoves(state) {
  const enemyCap = state.capitals[state.current === 'A' ? 'B' : 'A'];
  for (const { id } of state.stacks.filter((s) => s.owner === state.current)) {
    const stack = getStack(state, id);
    if (fortification(state, stack.col, stack.row) > 0) continue;
    const goal = (hex) => (nearestEnemy(state, hex) <= 4 ? nearestEnemy(state, hex) : distance(hex, enemyCap));
    const best = legalMoves(state, id).sort((a, b) => goal(a) - goal(b))[0];
    if (best && goal(best) < goal(stack)) state = moveStack(state, id, best.col, best.row);
  }
  return state;
}

const PRIORITY = ['counter', 'offensive', 'attack', 'fortify', 'logistics', 'homefront', 'posture', 'elastic', 'hold'];

function takeTurn(state) {
  state = freeMoves(state);
  let anyActed = false;
  for (let play = 0; play < state.cardsPerTurn && !state.over; play++) {
    const hand = state.hands[state.current]
      .filter((c) => cardIssue(state, c) === null && PRIORITY.includes(c.type))
      .sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type));
    let acted = false;
    for (const card of hand) {
      let current = playCard(state, card.uid);
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
  const kinds = ['moved', 'assaults', 'hasty', 'Trench built', 'rallies', 'merges', 'splits', 'rail', 'propaganda', 'relief',
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
