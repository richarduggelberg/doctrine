// Bot-vs-bot balance check: node tools/simulate.mjs [games] [maxTurns] [slackPerExhaustion]
import { readFileSync } from 'node:fs';
import {
  applyPool, applyToStack, assaultInfo, attack, cardIssue, chooseMode, createGame, discardCard, eligibleStacks,
  endOrder, endTurn, fortification, getStack, improvise, improviseIssue, isFace, legalAttacks, legalMerges, legalMoves,
  mergeStacks, moveStack, setIssue, placeRecruit, playCard, recruitSites, resolveRetreat, retreatOptions, shell,
  shellTargets, SHELL_FLOOR, SHELL_TRENCH_FLOOR,
} from '../js/engine.js';
import { distance, key } from '../js/hex.js';

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

// The beaten defender of a pending battle retreats toward home (a pocketed one never gets here: it stands at once).
function decide(state) {
  const loser = getStack(state, state.pending.loserId);
  const home = state.capitals[loser.owner];
  const best = retreatOptions(state).sort((a, b) => distance(a, home) - distance(b, home))[0];
  return resolveRetreat(state, best.col, best.row);
}

const ownAdjacent = (state, target) => state.stacks.filter((s) => s.owner === state.current && distance(s, target) === 1);

// Plan an attack order: assault where the odds are already good (cheapest ground first); otherwise shell a target
// that one assaulter could then beat, using other adjacent stacks as shooters; otherwise grind a weaker enemy.
function attackStep(state) {
  const a = state.active;
  const stacks = eligibleStacks(state);
  let win = null;
  for (const stack of stacks) {
    for (const target of legalAttacks(state, stack.id)) {
      const info = assaultInfo(state, stack, target, a.fx);
      if (!info.wins) continue;
      const score = -info.cost * 10 + target.men - info.attackStrength + info.defenseStrength;
      if (!win || score > win.score) win = { stack, target, score };
    }
  }
  if (win) {
    const next = attack(state, win.stack.id, win.target.id);
    return next.pending ? decide(next) : next;
  }
  if (process.env.SHELL !== '0') {
    let plan = null;
    for (const stack of stacks) {
      for (const target of legalAttacks(state, stack.id)) {
        const info = assaultInfo(state, stack, target, a.fx);
        const chips = Math.max(0, (state.defense[key(target.col, target.row)] ?? 0) - SHELL_TRENCH_FLOOR);
        const men = Math.max(0, target.men - SHELL_FLOOR);
        const need = info.defenseStrength - info.attackStrength + 1;
        const cost = Math.min(need, chips) + Math.max(0, need - chips) * a.manCost;
        if (need > chips + men || cost + a.attackCost > a.points || stack.men <= 1) continue;
        const shooter = ownAdjacent(state, target).find((s) => s.id !== stack.id && shellTargets(state, s.id).some((t) => t.id === target.id));
        if (shooter && (!plan || cost < plan.cost)) plan = { shooter, target, cost };
      }
    }
    if (plan) return shell(state, plan.shooter.id, plan.target.id);
  }
  // Grind the enemy that is not stronger in men.
  if (a.points >= a.attackCost) {
    for (const stack of stacks) {
      const target = legalAttacks(state, stack.id).filter((t) => t.men <= stack.men).sort((x, y) => y.men - x.men)[0];
      if (target && stack.men >= 3) return attack(state, stack.id, target.id);
    }
  }
  return null;
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
    if (a.points >= menu.rail) {
      const railing = chooseMode(state, 'rail');
      const target = eligibleStacks(railing).filter((s) => nearestEnemy(state, s) >= 4).sort((x, y) => y.men - x.men)[0];
      if (target) return applyToStack(railing, target.id);
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
  return state.active.kind === 'attack' ? attackStep(state) : poolStep(state);
}

// Reserves walk toward the enemy (or its capital) once the fighting stacks have acted; stacks that fought or
// merged cannot walk. Trenched stacks only leave their trench when the hand holds an offensive card to follow up.
function freeMoves(state) {
  const enemyCap = state.capitals[state.current === 'A' ? 'B' : 'A'];
  const offensive = state.hands[state.current].some((c) => c.suit === 'aggressive');
  for (const { id } of state.stacks.filter((s) => s.owner === state.current)) {
    for (let step = 0; step < state.move + getStack(state, id).rail; step++) {
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
  for (const x of process.env.PAIRS === '0' ? [] : hand) {
    for (const y of hand) {
      if (x.uid < y.uid && x.suit === y.suit && !isFace(x.rank) && !isFace(y.rank) && setIssue(state, [x, y]) === null) {
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

function playOrders(state, suits) {
  for (let guard = 0; guard < MAX_ORDERS && !state.over; guard++) {
    let acted = false;
    const opens = [
      ...candidates(state).filter(([uid]) => suits.includes(state.hands[state.current].find((c) => c.uid === uid).suit))
        .map((uids) => (s) => playCard(s, ...uids)),
      ...improvisations(state).filter(([, , to]) => suits.includes(to)).map((args) => (s) => improvise(s, ...args)),
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
      if (current.active?.acted) did = true;
      if (current.active) current = endOrder(current);
      state = current;
      if (did) {
        acted = true;
        break;
      }
    }
    if (!acted) break;
  }
  return state;
}

// Fight first (Offensive orders, with the stacks already in contact), then rail and walk the rest forward, then play
// the other orders (so a stack that just walked up can dig in).
function takeTurn(state) {
  state = playOrders(musterRecruits(state), ['aggressive']);
  state = playOrders(state, ['reorganizational']);
  state = playOrders(freeMoves(state), ['defensive', 'willingness']);
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
      'recruit', 'retreats', 'pocketed', 'assaults', 'grinds down', 'shells the trenches', ': -1 man', 'advances'];
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
