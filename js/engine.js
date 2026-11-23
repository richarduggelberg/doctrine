// Pure rules engine: every function takes a state and returns a new state.
// No DOM access, so it can run under Node for tests.
import { key, neighbors } from './hex.js';

export const PLAYERS = ['A', 'B'];
// Terrain modifiers, each worth this many chips of defence. A hex may carry several, written "hills+bigriver+city"
// in the map, and they all stack (the attacker pays for every one of them in blood).
export const TERRAIN_BONUS = {
  open: 0, sea: 0, rough: 1, fortified: 2,
  forest: 1, hills: 1, marsh: 1, mountain: 2,
  river: 1, bigriver: 2, city: 1, bigcity: 2, fortress: 2,
};
export const MIN_ATTACKER_MEN = 2;
export const HOLD_LOSS = 1; // on top of the attrition man: standing costs 2 men in total

// Pool orders hold points that are spent one menu entry at a time (see `menu` in cards.json).
const POOLS = new Set(['defend', 'logistics', 'homefront']);
// Menu entries that need a stack (or, for merge and split, a second target) to be chosen.
const TARGETED = new Set(['trench', 'brace', 'rail', 'rally', 'merge', 'split', 'recruit']);

// A doctrine is a small set of cards; the number of cards in a suit is that suit's level.
export function doctrineLevel(state, owner, suit) {
  return Math.min(state.maxLevel, state.doctrine[owner].cards[suit] ?? 0);
}

// Ordinary playing cards: rank 2-10, J 11, Q 12, K 13, Ace 14 (high). Each suit has a fixed function.
export const rankLabel = (rank) => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] ?? String(rank);
export const isFace = (rank) => rank >= 11;
// Ranks come in bands of three: 2-4 is tier 0, 5-7 tier 1, 8-10 tier 2, J-K tier 3 and the Ace tier 4.
export const bandOf = (rank) => Math.floor((rank - 2) / 3);

// A value from a per-tier table; a plain number is the same for every tier.
const at = (table, tier) => (Array.isArray(table) ? table[Math.min(tier, table.length - 1)] : table);

// The tier of an order: the rank band plus the doctrine shift of the suit, which can lift a card above its
// natural band (an 8-10 under a level 3 doctrine plays like a face card). Two same-suit number cards played
// together are worth their summed rank, plus one tier.
export function orderTier(state, owner, suit, ranks) {
  const shift = state.doctrineShift[doctrineLevel(state, owner, suit)] ?? 0;
  const base = ranks.length === 1 ? bandOf(ranks[0]) : Math.min(bandOf(ranks[0] + ranks[1]), 3) + 1;
  return Math.max(0, base + shift);
}

// What a card, or a same-suit pair, does for its owner: its order, tier, face ability and numeric values.
export function orderInfo(state, owner, cards) {
  const def = state.orders[cards[0].suit];
  const tier = orderTier(state, owner, cards[0].suit, cards.map((c) => c.rank));
  const face = cards.length === 1 && isFace(cards[0].rank) ? def.faces[rankLabel(cards[0].rank)] : null;
  const fx = face?.fx ?? {};
  const values = {};
  for (const [field, spec] of Object.entries(def)) {
    if (typeof spec === 'number' || Array.isArray(spec)) values[field] = at(spec, tier);
  }
  for (const field of ['extraCost', 'railHexes', 'braceAmount', 'propaganda', 'relief']) {
    if (fx[field] !== undefined) values[field] = fx[field];
  }
  if (values.points !== undefined) values.points += fx.bonusPoints ?? 0;
  if (values.limit !== undefined) values.limit += fx.limitBonus ?? 0;
  const menu = def.menu ? { ...def.menu, ...fx.costs } : null;
  return { def, tier, face, fx, values, menu };
}

// Card text with {field} placeholders filled in for the given owner, plus the face ability if it has one.
export function cardText(state, owner, cards) {
  const { def, face, values } = orderInfo(state, owner, [].concat(cards));
  const text = def.text.replace(/\{(\w+)\}/g, (_, field) => values[field] ?? 0);
  return face ? `${face.name}: ${face.text} ${text}` : text;
}

// Seeded generator (mulberry32) so shuffles are reproducible and the engine stays pure.
function nextRandom(state) {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = Math.imul(state.rng ^ (state.rng >>> 15), 1 | state.rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle(state, items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function territoryOf(state, col, row) {
  if (state.countries) return state.owners[state.countries[row]?.[col]] ?? null;
  return col <= state.borderCol ? PLAYERS[0] : PLAYERS[1];
}

// Country code of a hex ('~' for sea); only maps with countries have one.
export function countryAt(state, col, row) {
  return state.countries?.[row]?.[col] ?? null;
}

// Towns: every named place on a player's own soil starts in that player's hands. A stack of the other player
// standing on it takes it, and it stays taken until someone else's stack stands there. Neutral towns never change hands.
export function updateTowns(state) {
  for (const town of state.towns) {
    const stack = stackAt(state, town.col, town.row);
    if (!town.home || !stack || stack.owner === town.holder) continue;
    town.holder = stack.owner;
    state.log.push(
      stack.owner === town.home ? `${stack.id} retakes ${town.name}` : `${stack.id} captures ${town.name} from Player ${town.home}`,
    );
  }
}

// Towns of `owner` that the enemy holds, and what they cost it in exhaustion each turn.
export function townsLost(state, owner) {
  return state.towns.filter((t) => t.home === owner && t.holder !== owner);
}

export function townWeight(state, town) {
  return town.size === 'big' ? state.surrender.bigTownWeight : state.surrender.townWeight;
}

// Break score: how close a nation is to giving up. Public information (casualties,
// lost battles, lost home ground); only the threshold it is compared with is hidden.
export function breakScore(state, owner) {
  const s = state.surrender;
  let score = state.casualties[owner] + s.battleWeight * state.battlesLost[owner] + state.weariness[owner] + state.exhaustion[owner];
  for (const stack of state.stacks) {
    if (stack.owner === owner || territoryOf(state, stack.col, stack.row) !== owner) continue;
    const cap = state.capitals[owner];
    score += stack.col === cap.col && stack.row === cap.row ? s.capitalWeight : s.homeHexWeight;
  }
  return Math.max(0, score - state.resolve[owner]);
}

function endGame(state, loser, reason) {
  state.over = {
    loser,
    winner: PLAYERS.find((p) => p !== loser),
    reason,
    scores: Object.fromEntries(PLAYERS.map((p) => [p, breakScore(state, p)])),
    thresholds: { ...state.thresholds },
  };
  state.log.push(`Player ${loser} surrenders (${reason}). Player ${state.over.winner} wins.`);
}

// Each player draws from their own 52-card deck; a spent deck is refilled from that player's discards.
function draw(state, owner) {
  while (state.hands[owner].length < state.handSize) {
    if (state.decks[owner].length === 0) {
      if (state.discards[owner].length === 0) return;
      state.decks[owner] = shuffle(state, state.discards[owner]);
      state.discards[owner] = [];
    }
    state.hands[owner].push(state.decks[owner].pop());
  }
}

export function createGame(map, config, seed = 1) {
  const counters = { A: 0, B: 0 };
  const stacks = map.stacks.map((s) => ({
    id: `${s.owner}${++counters[s.owner]}`,
    owner: s.owner,
    col: s.col,
    row: s.row,
    men: s.men,
    army: s.army ?? null, // historical name, display only
    gear: 0,
    braced: 0,
    spent: false,
    moved: 0,
    rail: 0,
    halted: false,
    fought: false,
    cut: 0,
  }));
  const state = {
    cols: map.cols,
    rows: map.rows,
    // Territory follows the countries: `countries` has one letter per hex (one string per row) and `owners` says
    // which player each country belongs to; the rest (Belgium, ...) is neutral. Without them, columns up to
    // `borderCol` are Player A's and the rest Player B's.
    countries: map.countries ?? null,
    owners: map.owners ?? {},
    borderCol: map.borderCol ?? Math.floor(map.cols / 2) - 1,
    terrain: { ...map.terrain },
    // Map decoration only (labels, outlines, rivers), in hex units; the rules never read it.
    scenery: { places: map.places ?? [], rivers: map.rivers ?? [], countryLabels: map.countryLabels ?? [] },
    menPerChip: map.menPerChip ?? null,
    capitals: structuredClone(map.capitals),
    stacks,
    idCounters: counters,
    defense: { ...map.defense },
    // Free movement: hexes a stack may walk per turn. Entering an enemy zone is free but ends the walk.
    move: config.move ?? 2,
    // Elastic defence: retreats are free until the owner's next turn begins.
    elastic: { A: false, B: false },
    orders: Object.fromEntries(
      Object.entries(config.orders).map(([suit, order]) => [suit, { ...structuredClone(order), symbol: config.symbols[suit] }]),
    ),
    doctrine: structuredClone(config.doctrine),
    doctrineShift: [...config.doctrineShift],
    maxLevel: config.maxLevel,
    handSize: config.handSize,
    cardsPerTurn: config.cardsPerTurn,
    rng: seed | 0,
    // One deck per player (a standard 52 cards), and each player's own discard pile.
    decks: { A: [], B: [] },
    discards: { A: [], B: [] },
    hands: { A: [], B: [] },
    played: 0,
    discardUsed: false,
    active: null,
    current: PLAYERS[0],
    turn: 1,
    casualties: { A: 0, B: 0 },
    battlesLost: { A: 0, B: 0 },
    // War weariness: +1 for each of a nation's turns that ends without capturing a hex; a capture resets it.
    weariness: { A: 0, B: 0 },
    // Exhaustion: a constant tick at the end of each of a nation's turns for every town the enemy holds. It never resets.
    exhaustion: { A: 0, B: 0 },
    towns: (map.places ?? []).map((p) => ({ ...p, home: null, holder: null })),
    captured: false,
    // A stack on the enemy capital is 'armed'; if it is still there when the enemy's turn ends, the war is won.
    siege: { A: null, B: null },
    resolve: { A: 0, B: 0 },
    surrender: { ...config.surrender },
    thresholds: {},
    over: null,
    pending: null,
    log: ['Game start. Player A moves first.'],
  };
  const { thresholdMin, thresholdMax, willingnessThreshold, publicResolve } = config.surrender;
  for (const town of state.towns) town.holder = town.home = territoryOf(state, town.col, town.row);
  for (const owner of PLAYERS) {
    const willingness = state.doctrine[owner].cards.willingness ?? 0;
    const base = thresholdMin + Math.floor(nextRandom(state) * (thresholdMax - thresholdMin + 1));
    state.thresholds[owner] = base + willingnessThreshold * willingness;
    // A declared (face-up) doctrine rallies the nation; a secret one keeps the enemy guessing.
    if (state.doctrine[owner].public) {
      state.resolve[owner] = publicResolve;
      state.log.push(`Player ${owner} declares its doctrine openly (resolve +${publicResolve})`);
    }
  }
  for (const owner of PLAYERS) {
    for (const [initial, suit] of Object.entries(config.suits)) {
      for (let rank = 2; rank <= 14; rank++) {
        state.decks[owner].push({ uid: `${owner}:${initial}${rank}`, suit, rank });
      }
    }
    shuffle(state, state.decks[owner]);
    draw(state, owner);
  }
  return state;
}

export function inBounds(state, col, row) {
  return col >= 0 && row >= 0 && col < state.cols && row < state.rows && terrainAt(state, col, row) !== 'sea';
}

export function terrainAt(state, col, row) {
  return state.terrain[key(col, row)] ?? 'open';
}

// The modifiers on a hex, e.g. ['hills', 'bigriver', 'city'] for "hills+bigriver+city".
export function featuresAt(state, col, row) {
  const terrain = terrainAt(state, col, row);
  return terrain === 'open' ? [] : terrain.split('+');
}

// Defence from terrain alone: the sum of every modifier on the hex.
export function terrainBonus(state, col, row) {
  return featuresAt(state, col, row).reduce((sum, f) => sum + (TERRAIN_BONUS[f] ?? 0), 0);
}

export function stackAt(state, col, row) {
  return state.stacks.find((s) => s.col === col && s.row === row);
}

export function getStack(state, id) {
  return state.stacks.find((s) => s.id === id);
}

// Terrain and trench chips in a hex: the defence a stack there gets, and what an attacker pays in blood.
export function fortification(state, col, row) {
  return terrainBonus(state, col, row) + (state.defense[key(col, row)] ?? 0);
}

// A stack that has just advanced is spent: -1 strength until its owner's next turn begins.
export function strength(state, stack, defending) {
  const base = stack.men + stack.gear - (stack.spent ? 1 : 0);
  if (!defending) return base;
  return base + fortification(state, stack.col, stack.row) + stack.braced;
}

function adjacentStacks(state, stack, owned) {
  return neighbors(stack.col, stack.row)
    .map((n) => stackAt(state, n.col, n.row))
    .filter((s) => s && (s.owner === stack.owner) === owned);
}

function emptyNeighbors(state, stack) {
  return neighbors(stack.col, stack.row).filter(
    (n) => inBounds(state, n.col, n.row) && !stackAt(state, n.col, n.row),
  );
}

// Zone of control: every hex next to a stack. A hex is in the enemy zone if an enemy stack touches it.
export function inEnemyZoc(state, owner, col, row) {
  return neighbors(col, row).some((n) => {
    const s = stackAt(state, n.col, n.row);
    return s && s.owner !== owner && s.men > 0;
  });
}

// Supply: a stack needs a path back to its own capital that crosses no enemy zone and no enemy stack.
// Its own hex is exempt (front-line stacks always sit in a zone) and so is the capital hex itself.
// A stack that has no such path is cut off (surrounded): it can do nothing and bleeds each turn.
export function isCutOff(state, stack) {
  const cap = state.capitals[stack.owner];
  const seen = new Set([key(stack.col, stack.row)]);
  const queue = [stack];
  while (queue.length) {
    const here = queue.shift();
    for (const n of neighbors(here.col, here.row)) {
      const k = key(n.col, n.row);
      if (seen.has(k) || !inBounds(state, n.col, n.row)) continue;
      seen.add(k);
      const other = stackAt(state, n.col, n.row);
      if (other && other.owner !== stack.owner) continue;
      const home = n.col === cap.col && n.row === cap.row;
      if (home) return false;
      if (!inEnemyZoc(state, stack.owner, n.col, n.row)) queue.push(n);
    }
  }
  return !(stack.col === cap.col && stack.row === cap.row);
}

// Hexes a stack can walk or split into: empty and outside every enemy zone.
function freeNeighbors(state, stack) {
  return emptyNeighbors(state, stack).filter((n) => !inEnemyZoc(state, stack.owner, n.col, n.row));
}

// A stack walks `move` hexes per turn (plus rail). Entering an enemy zone is free but ends the walk (`halted`),
// and a stack that fought cannot walk any more.
function canStep(state, stack) {
  return !stack.fought && !stack.halted && stack.moved < state.move + stack.rail;
}

function directTargets(state, stack) {
  if (isCutOff(state, stack)) return [];
  return adjacentStacks(state, stack, false);
}

// Can this stack be the subject of an order of the given kind?
function eligible(state, kind, stack) {
  if (isCutOff(state, stack)) return false;
  switch (kind) {
    case 'attack': return stack.men >= MIN_ATTACKER_MEN && directTargets(state, stack).length > 0;
    case 'defend':
    case 'logistics':
    case 'homefront': return true;
    default: return false;
  }
}

// Why these cards (one, or two of a suit played together) cannot be played right now, or null if they can.
function playIssue(state, cards) {
  if (state.over) return 'The game is over';
  if (state.pending) return 'Resolve the battle first';
  if (state.active) return 'Finish the current order first';
  if (state.played + cards.length > state.cardsPerTurn) return 'No card plays left this turn';
  if (cards.length > 1) {
    if (cards[0].suit !== cards[1].suit) return 'A pair needs two cards of the same suit';
    if (cards.some((c) => isFace(c.rank))) return 'Face cards and aces cannot be paired';
  }
  const { def } = orderInfo(state, state.current, cards);
  const own = state.stacks.filter((s) => s.owner === state.current);
  if (!own.some((s) => eligible(state, def.kind, s))) return 'No stack can use this order';
  return null;
}

export function cardIssue(state, card) {
  return playIssue(state, [card]);
}

// Can `card` be played together with `other` (a same-suit pair uses both of the turn's plays)?
export function pairIssue(state, card, other) {
  return playIssue(state, [card, other]);
}

// Play one card, or a pair of same-suit number cards for a stronger order that uses both plays.
export function playCard(state, uid, secondUid = null) {
  const hand = state.hands[state.current];
  const cards = [uid, secondUid].filter(Boolean).map((id) => hand.find((c) => c.uid === id));
  if (cards.some((c) => !c)) throw new Error('Card is not in the current hand');
  if (new Set(cards.map((c) => c.uid)).size !== cards.length) throw new Error('A pair needs two different cards');
  const issue = playIssue(state, cards);
  if (issue) throw new Error(issue);
  const next = structuredClone(state);
  const owner = next.current;
  const { def, tier, face, fx, values, menu } = orderInfo(next, owner, cards);
  next.hands[owner] = next.hands[owner].filter((c) => !cards.some((p) => p.uid === c.uid));
  next.played += cards.length;
  const label = cards.map((c) => `${next.orders[c.suit].symbol ?? ''}${rankLabel(c.rank)}`).join('+');
  next.log.push(`${owner} plays ${label}: ${face ? face.name : def.name} (tier ${tier})`);
  // Defence face cards also act at once, whatever the points are spent on.
  if (fx.elastic) {
    next.elastic[owner] = true;
    next.log.push(`${owner}'s retreats are free until their next turn`);
  }
  if (fx.posture) {
    for (const s of next.stacks) if (s.owner === owner) s.braced = Math.max(s.braced, fx.posture);
    next.log.push(`${owner}: all stacks braced (+${fx.posture})`);
  }
  next.active = {
    cards,
    kind: def.kind,
    charges: 1,
    points: values.points ?? 0,
    extraCost: values.extraCost ?? 0,
    values,
    fx,
    menu,
    // A single-entry menu needs no choosing.
    mode: menu && Object.keys(menu).length === 1 ? Object.keys(menu)[0] : null,
    acted: false,
    used: [],
  };
  return next;
}

function finishActive(next) {
  next.discards[next.current].push(...next.active.cards);
  next.active = null;
}

function consume(next, stackId) {
  next.active.charges -= 1;
  next.active.acted = true;
  next.active.used.push(stackId);
  if (next.active.charges <= 0) finishActive(next);
}

function cancelActive(next) {
  const name = next.orders[next.active.cards[0].suit].name;
  if (!next.active.acted) {
    next.hands[next.current].push(...next.active.cards);
    next.played -= next.active.cards.length;
    next.log.push(`${next.current} cancels ${name}`);
    next.active = null;
  } else {
    next.log.push(`${next.current} ends ${name}`);
    finishActive(next);
  }
}

// Cancel an unused order (card returns to hand) or end a partly used one.
export function endOrder(state) {
  if (!state.active || state.pending) throw new Error('No order to end');
  const next = structuredClone(state);
  cancelActive(next);
  return next;
}

export function discardCard(state, uid) {
  const card = state.hands[state.current].find((c) => c.uid === uid);
  if (!card || state.discardUsed || state.pending || state.over) throw new Error('Cannot discard');
  const next = structuredClone(state);
  next.hands[next.current] = next.hands[next.current].filter((c) => c.uid !== uid);
  next.discards[next.current].push(card);
  next.discardUsed = true;
  next.log.push(`${next.current} discards ${rankLabel(card.rank)} of ${card.suit}`);
  return next;
}

function activeFor(state, kind, stack) {
  const a = state.active;
  return a && !state.pending && !state.over && a.kind === kind && stack && stack.owner === state.current ? a : null;
}

// What a stack can target with the active pool card's current menu entry:
// the stack itself, a friendly stack to merge into, or a hex to split into.
function poolOptions(state, mode, stack) {
  if (isCutOff(state, stack)) return [];
  const { values } = state.active;
  switch (mode) {
    case 'trench': return (state.defense[key(stack.col, stack.row)] ?? 0) < values.limit ? [stack] : [];
    case 'brace': return stack.braced < values.braceAmount ? [stack] : [];
    case 'rail': return stack.fought ? [] : [stack];
    case 'rally': return stack.gear < Math.min(values.limit, stack.men) ? [stack] : [];
    case 'merge': return adjacentStacks(state, stack, true);
    case 'split': return stack.men >= 2 ? freeNeighbors(state, stack) : [];
    case 'recruit': return territoryOf(state, stack.col, stack.row) === stack.owner ? [stack] : [];
    default: return [];
  }
}

function poolReady(a) {
  return POOLS.has(a.kind) && a.mode && a.points >= a.menu[a.mode];
}

// Stacks that can currently be chosen for the active order.
export function eligibleStacks(state) {
  const a = state.active;
  if (!a || state.pending || state.over) return [];
  const mine = state.stacks.filter((s) => s.owner === state.current);
  if (POOLS.has(a.kind)) {
    if (!poolReady(a) || !TARGETED.has(a.mode)) return [];
    return mine.filter((s) => poolOptions(state, a.mode, s).length > 0);
  }
  return mine.filter((s) => !a.used.includes(s.id) && eligible(state, a.kind, s));
}

export function isDirectOrder(state) {
  const a = state.active;
  return Boolean(a) && POOLS.has(a.kind) && Boolean(a.mode) && !['merge', 'split'].includes(a.mode);
}

// Menu entries of the active pool card, with their costs.
export function poolMenu(state) {
  return state.active?.menu ?? null;
}

// Pick a menu entry on a pool card with more than one.
export function chooseMode(state, mode) {
  const a = state.active;
  if (!a?.menu || !(mode in a.menu)) throw new Error(`No such menu entry: ${mode}`);
  if (a.points < a.menu[mode]) throw new Error('Not enough points');
  const next = structuredClone(state);
  next.active.mode = mode;
  return next;
}

export function needsTarget(mode) {
  return TARGETED.has(mode);
}

// Free movement: a stack walks up to `move` hexes (plus rail) per turn through empty hexes, and every hex it can
// reach in one go is a legal destination (`dist` steps away). Entering an enemy zone is free but ends the walk,
// so a zone hex is only ever the last step; a stack already in an enemy zone must first step out into a free hex.
// A stack that fought cannot walk.
function walkReach(state, stack) {
  const reach = new Map();
  const budget = state.move + stack.rail - stack.moved;
  let frontier = [{ col: stack.col, row: stack.row }];
  for (let dist = 1; dist <= budget && frontier.length; dist++) {
    const next = [];
    for (const from of frontier) {
      const steps = neighbors(from.col, from.row).filter(
        (n) => inBounds(state, n.col, n.row) && !stackAt(state, n.col, n.row) && !reach.has(key(n.col, n.row)),
      );
      for (const n of steps) {
        const zone = inEnemyZoc(state, stack.owner, n.col, n.row);
        if (dist === 1 && inEnemyZoc(state, stack.owner, stack.col, stack.row) && zone) continue;
        reach.set(key(n.col, n.row), { col: n.col, row: n.row, dist });
        if (!zone) next.push(n);
      }
    }
    frontier = next;
  }
  return reach;
}

export function legalMoves(state, id) {
  const stack = getStack(state, id);
  if (!stack || stack.owner !== state.current || state.pending || state.over || !canStep(state, stack) || isCutOff(state, stack)) return [];
  return [...walkReach(state, stack).values()];
}

export function moveStack(state, id, col, row) {
  const move = legalMoves(state, id).find((m) => m.col === col && m.row === row);
  if (!move) throw new Error(`Illegal move for ${id} to ${col},${row}`);
  const next = structuredClone(state);
  const stack = getStack(next, id);
  next.log.push(`${id} moved (${stack.col},${stack.row}) -> (${col},${row})${move.dist > 1 ? ` (${move.dist} hexes)` : ''}`);
  stack.col = col;
  stack.row = row;
  stack.braced = 0;
  stack.moved += move.dist;
  if (inEnemyZoc(next, stack.owner, col, row)) stack.halted = true;
  updateTowns(next);
  return next;
}

// Enemy stacks the given stack may attack from where it stands. Attacking costs 1 man, so a lone man cannot.
export function legalAttacks(state, id) {
  const stack = getStack(state, id);
  const a = activeFor(state, 'attack', stack);
  if (!a || a.used.includes(id) || stack.men < MIN_ATTACKER_MEN) return [];
  return directTargets(state, stack);
}

// Offensive points are a pool: the first attack is free, every further attack costs
// `extraCost` points, and each remaining point adds +1 strength to one attack.
export function maxBonus(state) {
  const a = state.active;
  if (!a || a.kind !== 'attack') return 0;
  return Math.max(0, a.points - (a.used.length ? a.extraCost : 0));
}

function loseMen(state, stack, count) {
  const lost = Math.min(count, stack.men);
  stack.men -= lost;
  // Experience cannot exceed the men who carry it.
  stack.gear = Math.min(stack.gear, stack.men);
  state.casualties[stack.owner] += lost;
  return lost;
}

export function attack(state, attackerId, defenderId, bonus = 0) {
  if (!legalAttacks(state, attackerId).some((t) => t.id === defenderId)) {
    throw new Error(`Illegal attack ${attackerId} -> ${defenderId}`);
  }
  const extra = state.active.used.length ? state.active.extraCost : 0;
  if (!Number.isInteger(bonus) || bonus < 0 || bonus + extra > state.active.points) {
    throw new Error(`Bonus ${bonus} is not affordable`);
  }
  const next = structuredClone(state);
  const attacker = getStack(next, attackerId);
  const defender = getStack(next, defenderId);
  const a = next.active;
  a.points -= bonus + extra;
  // One more attack is possible only if the pool can pay for it; consume() then ends the order otherwise.
  a.charges = a.extraCost && a.points >= a.extraCost ? 2 : 1;
  attacker.fought = true;
  const attackStrength = strength(next, attacker, false) + bonus;
  const trenches = a.fx.ignoreTrenches ? next.defense[key(defender.col, defender.row)] ?? 0 : 0;
  const defenseStrength = strength(next, defender, true) - trenches;
  const verdict =
    attackStrength > defenseStrength ? 'attacker' : attackStrength < defenseStrength ? 'defender' : 'stalemate';

  // Bloodletting: the attacker pays for the defender's terrain and trench chips (min 1);
  // the defender pays 1 plus the offensive points spent (artillery weight). Whoever wins.
  attacker.braced = 0;
  const attackerLoss = loseMen(next, attacker, Math.max(1, fortification(next, defender.col, defender.row)));
  const breakthrough = verdict === 'attacker' && a.fx.breakthrough;
  const defenderLoss = loseMen(next, defender, 1 + bonus + (breakthrough ? 1 : 0));
  // Experience comes from attacking: a defender who holds gains nothing.
  if (verdict === 'attacker') {
    attacker.gear = Math.min(attacker.gear + 1, attacker.men);
    next.battlesLost[defender.owner] += 1;
  } else if (verdict === 'defender') {
    next.battlesLost[attacker.owner] += 1;
  }
  const battle = {
    attackerId,
    defenderId,
    winnerId: verdict === 'attacker' ? attackerId : null,
    loserId: defenderId,
    defenderCol: defender.col,
    defenderRow: defender.row,
    noRetreat: Boolean(a.fx.noRetreat),
    fresh: Boolean(breakthrough),
  };
  const outcome = {
    attacker: `${attackerId} has the upper hand`,
    defender: `${defenderId} repels the attack`,
    stalemate: 'stalemate',
  }[verdict];
  next.log.push(
    `${attackerId} (${attackStrength}${bonus ? `, incl. +${bonus}` : ''}) attacks ${defenderId} (${defenseStrength}): ` +
      `${outcome}; ${attackerId} loses ${attackerLoss}, ${defenderId} loses ${defenderLoss}.`,
  );
  // Only an attacker with the upper hand forces the surviving defender to choose.
  if (verdict === 'attacker' && defender.men > 0) next.pending = battle;
  else finishBattle(next, battle);
  consume(next, attackerId);
  return next;
}

// A retreat costs 1 gear, or 1 man if the stack has none, so it needs a chip to spare
// (free under elastic defence). It must end outside every enemy zone.
// A cut-off stack cannot retreat either: it must stand, and neither can the victim of "no quarter".
export function retreatOptions(state) {
  const pending = state.pending;
  if (!pending || pending.noRetreat) return [];
  const loser = getStack(state, pending.loserId);
  if (isCutOff(state, loser)) return [];
  if (!state.elastic[loser.owner] && loser.gear === 0 && loser.men < 2) return [];
  return freeNeighbors(state, loser);
}

function finishBattle(next, battle) {
  next.stacks = next.stacks.filter((s) => s.men > 0);
  next.pending = null;
  // An attacker with the upper hand takes the hex if the defender left it or was destroyed.
  const attacker = getStack(next, battle.attackerId);
  if (
    attacker &&
    battle.winnerId === battle.attackerId &&
    !stackAt(next, battle.defenderCol, battle.defenderRow)
  ) {
    attacker.col = battle.defenderCol;
    attacker.row = battle.defenderRow;
    attacker.spent = !battle.fresh;
    next.captured = true;
    next.log.push(`${attacker.id} advances to (${attacker.col},${attacker.row})${battle.fresh ? '' : ' and is spent'}`);
  }
  updateTowns(next);
  // A nation with no stacks left cannot fight on.
  const wiped = PLAYERS.find((p) => !next.stacks.some((s) => s.owner === p));
  if (wiped) endGame(next, wiped, 'all stacks destroyed');
}

function requirePending(state) {
  if (!state.pending) throw new Error('No battle awaiting a decision');
  return state.pending;
}

export function resolveHold(state) {
  const pending = requirePending(state);
  const next = structuredClone(state);
  const loser = getStack(next, pending.loserId);
  const lost = loseMen(next, loser, HOLD_LOSS);
  next.log.push(`${loser.id} stands and loses ${lost} more man${loser.men === 0 ? ' (destroyed)' : ''}`);
  finishBattle(next, pending);
  return next;
}

export function resolveRetreat(state, col, row) {
  const pending = requirePending(state);
  if (!retreatOptions(state).some((o) => o.col === col && o.row === row)) {
    throw new Error(`Illegal retreat to ${col},${row}`);
  }
  const next = structuredClone(state);
  const loser = getStack(next, pending.loserId);
  const cost = next.elastic[loser.owner] ? 'nothing (elastic defence)' : loser.gear > 0 ? '1 gear' : '1 man';
  if (!next.elastic[loser.owner]) {
    if (loser.gear > 0) loser.gear -= 1;
    else loseMen(next, loser, 1);
  }
  loser.col = col;
  loser.row = row;
  loser.braced = 0;
  next.log.push(`${loser.id} retreats to (${col},${row}), losing ${cost}`);
  finishBattle(next, pending);
  return next;
}

export function legalMerges(state, id) {
  const stack = getStack(state, id);
  const a = activeFor(state, 'logistics', stack);
  return a && a.mode === 'merge' && poolReady(a) ? poolOptions(state, 'merge', stack) : [];
}

// Pays for one menu entry of the active pool card; the order ends when nothing more is affordable.
function spend(next, cost) {
  const a = next.active;
  a.points -= cost;
  a.acted = true;
  if (a.points < Math.min(...Object.values(a.menu))) finishActive(next);
}

export function mergeStacks(state, sourceId, targetId) {
  if (!legalMerges(state, sourceId).some((s) => s.id === targetId)) {
    throw new Error(`Illegal merge ${sourceId} -> ${targetId}`);
  }
  const next = structuredClone(state);
  const source = getStack(next, sourceId);
  const target = getStack(next, targetId);
  target.men += source.men;
  target.gear += source.gear;
  target.braced = Math.min(target.braced, source.braced);
  target.spent = target.spent || source.spent;
  target.fought = target.fought || source.fought;
  target.halted = target.halted || source.halted;
  target.moved = Math.max(target.moved, source.moved);
  target.rail = Math.min(target.rail, source.rail);
  next.stacks = next.stacks.filter((s) => s.id !== sourceId);
  next.log.push(`${sourceId} merges into ${targetId} (${target.men} men, ${target.gear} gear)`);
  spend(next, next.active.menu.merge);
  return next;
}

export function legalSplits(state, id) {
  const stack = getStack(state, id);
  const a = activeFor(state, 'logistics', stack);
  return a && a.mode === 'split' && poolReady(a) ? poolOptions(state, 'split', stack) : [];
}

export function splitStack(state, id, col, row) {
  if (!legalSplits(state, id).some((h) => h.col === col && h.row === row)) {
    throw new Error(`Illegal split of ${id} to ${col},${row}`);
  }
  const next = structuredClone(state);
  const stack = getStack(next, id);
  const sent = Math.floor(stack.men / 2);
  const gearSent = Math.floor(stack.gear / 2);
  stack.men -= sent;
  stack.gear -= gearSent;
  const newId = `${stack.owner}${++next.idCounters[stack.owner]}`;
  // The new stack has used its walk getting there.
  next.stacks.push({
    id: newId, owner: stack.owner, col, row, men: sent, gear: gearSent, braced: 0, spent: false,
    moved: next.move, rail: 0, halted: false, fought: false, cut: 0,
  });
  next.log.push(`${id} splits: ${newId} (${sent} men${gearSent ? `, ${gearSent} gear` : ''}) at (${col},${row})`);
  updateTowns(next);
  spend(next, next.active.menu.split);
  return next;
}

// Pool menu entries that need no target: propaganda and relief on the home front.
export function applyPool(state, mode) {
  const a = state.active;
  if (!a || a.kind !== 'homefront' || !(mode in a.menu) || TARGETED.has(mode) || a.points < a.menu[mode] || state.pending) {
    throw new Error(`Cannot use ${mode} now`);
  }
  const next = structuredClone(state);
  const owner = next.current;
  if (mode === 'propaganda') {
    const gain = a.values.propaganda;
    next.resolve[owner] += gain;
    next.log.push(`${owner} propaganda: resolve +${gain}`);
  } else {
    const eased = Math.min(a.values.relief, next.weariness[owner]);
    next.weariness[owner] -= eased;
    next.log.push(`${owner} relief: war weariness -${eased}`);
  }
  spend(next, next.active.menu[mode]);
  return next;
}

// Applies a targeted pool entry (trench, brace, rail, rally, recruit) to the chosen stack.
export function applyToStack(state, id) {
  const stack = getStack(state, id);
  if (!isDirectOrder(state) || !eligibleStacks(state).some((s) => s.id === id) || !stack) {
    throw new Error(`Order cannot target ${id}`);
  }
  const next = structuredClone(state);
  const target = getStack(next, id);
  const a = next.active;
  switch (a.mode) {
    case 'trench': {
      const k = key(target.col, target.row);
      next.defense[k] = (next.defense[k] ?? 0) + 1;
      next.log.push(`Trench built at (${target.col},${target.row})`);
      break;
    }
    case 'brace':
      target.braced = Math.max(target.braced, a.values.braceAmount);
      next.log.push(`${id} digs in: +${a.values.braceAmount} defence`);
      break;
    case 'rail':
      target.rail += a.values.railHexes;
      next.log.push(`${id} gets rail: +${a.values.railHexes} hexes of movement`);
      break;
    case 'rally':
      target.gear += 1;
      next.log.push(`${id} rallies: +1 gear`);
      break;
    case 'recruit':
      target.men += 1;
      next.log.push(`${id} receives a recruit: +1 man`);
      break;
    default:
      throw new Error(`Unknown order ${a.kind}/${a.mode}`);
  }
  spend(next, a.menu[a.mode]);
  return next;
}

export function endTurn(state) {
  if (state.pending) throw new Error('Resolve the battle first');
  if (state.over) throw new Error('The game is over');
  const next = structuredClone(state);
  if (next.active) cancelActive(next);
  draw(next, next.current);
  if (next.over) return next;
  const ender = next.current;
  const enemy = PLAYERS.find((p) => p !== ender);
  // Capital siege: the enemy held our capital through our whole turn, so the war is lost.
  const onCapital = (owner, capitalOwner) =>
    next.stacks.some(
      (s) => s.owner === owner && s.col === next.capitals[capitalOwner].col && s.row === next.capitals[capitalOwner].row,
    );
  if (next.siege[enemy] === 'armed' && onCapital(enemy, ender)) {
    endGame(next, ender, 'capital held for a full round');
    return next;
  }
  next.siege[enemy] = onCapital(enemy, ender) ? next.siege[enemy] : null;
  if (onCapital(ender, enemy)) {
    if (!next.siege[ender]) next.log.push(`${ender} stands on the enemy capital: hold it through the enemy turn to win`);
    next.siege[ender] = 'armed';
  } else {
    next.siege[ender] = null;
  }
  // War weariness: a turn without ground captured wears the nation down; a capture restores heart.
  if (next.captured) next.weariness[ender] = 0;
  else {
    next.weariness[ender] += 1;
    next.log.push(`${ender} gained no ground: war weariness ${next.weariness[ender]}`);
  }
  next.captured = false;
  // Exhaustion: each town the enemy holds costs this nation a little more every turn it stays lost.
  const lostTowns = townsLost(next, ender);
  const tick = lostTowns.reduce((sum, t) => sum + townWeight(next, t), 0);
  if (tick) {
    next.exhaustion[ender] += tick;
    next.log.push(`${ender} has lost ${lostTowns.length} town${lostTowns.length === 1 ? '' : 's'}: exhaustion +${tick}`);
  }
  // The nation breaks when its (public) break score reaches its hidden threshold, checked at the end of its own turn.
  if (breakScore(next, ender) >= next.thresholds[ender]) {
    endGame(next, ender, 'will to fight broken');
    return next;
  }
  next.current = enemy;
  if (next.current === PLAYERS[0]) next.turn += 1;
  next.played = 0;
  next.discardUsed = false;
  next.elastic[next.current] = false;
  // Surrounded stacks bleed at the start of each of their owner's turns: a gear chip first, then a man every turn.
  for (const stack of next.stacks.filter((s) => s.owner === next.current)) {
    if (!isCutOff(next, stack)) {
      stack.cut = 0;
      continue;
    }
    stack.cut += 1;
    if (stack.gear > 0) {
      stack.gear -= 1;
      next.log.push(`${stack.id} is surrounded and loses 1 gear`);
    } else {
      loseMen(next, stack, 1);
      next.log.push(`${stack.id} is surrounded and loses 1 man`);
    }
  }
  next.stacks = next.stacks.filter((s) => s.men > 0);
  const wiped = PLAYERS.find((p) => !next.stacks.some((s) => s.owner === p));
  if (wiped) {
    endGame(next, wiped, 'all stacks destroyed');
    return next;
  }
  for (const stack of next.stacks) {
    if (stack.owner === next.current) {
      stack.braced = 0;
      stack.spent = false;
      stack.moved = 0;
      stack.rail = 0;
      stack.halted = false;
      stack.fought = false;
    }
  }
  next.log.push(`Turn ${next.turn}: Player ${next.current}`);
  return next;
}
