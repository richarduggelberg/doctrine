// Pure rules engine: every function takes a state and returns a new state.
// No DOM access, so it can run under Node for tests.
import { distance, key, neighbors } from './hex.js';

export const PLAYERS = ['A', 'B'];
export const TERRAIN_BONUS = { open: 0, rough: 1, fortified: 2 };
export const MIN_ATTACKER_MEN = 2;
export const HOLD_LOSS = 1; // on top of the attrition man: standing costs 2 men in total

// Orders that apply immediately when played; all others need a stack target.
const IMMEDIATE = new Set(['posture', 'propaganda']);
// Orders applied by clicking a single stack.
const DIRECT = new Set(['hold', 'entrench', 'rally', 'martial']);

// A doctrine is a small set of cards; the number of cards in a suit is that suit's level.
// Levels are capped, and level 0 is playable at a reduced effect (no dead suits).
export function doctrineLevel(state, owner, suit) {
  if (suit === 'general') return 0;
  return Math.min(state.maxLevel, state.doctrine[owner].cards[suit] ?? 0);
}

// Value of a card field for its owner. A string names a table in `levels[suit]`
// indexed by doctrine level; a number is a fixed value.
export function cardValue(state, owner, def, field, fallback = 0) {
  const spec = def[field];
  if (typeof spec !== 'string') return spec ?? fallback;
  return state.levels[def.suit][spec][doctrineLevel(state, owner, def.suit)];
}

// Card text with {field} placeholders filled in for the given owner.
export function cardText(state, owner, def) {
  return def.text.replace(/\{(\w+)\}/g, (_, field) => cardValue(state, owner, def, field));
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

export function territoryOf(state, col) {
  return col <= state.borderCol ? PLAYERS[0] : PLAYERS[1];
}

// Break score: how close a nation is to giving up. Public information (casualties,
// lost battles, lost home ground); only the threshold it is compared with is hidden.
export function breakScore(state, owner) {
  const s = state.surrender;
  let score = state.casualties[owner] + s.battleWeight * state.battlesLost[owner];
  for (const stack of state.stacks) {
    if (stack.owner === owner || territoryOf(state, stack.col) !== owner) continue;
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

// A drawn surrender card is resolved at once: only the drawer is checked against their
// hidden threshold. It is never kept in hand; it returns to the discard pile.
function resolveSurrenderDraw(state, owner) {
  const score = breakScore(state, owner);
  if (score >= state.thresholds[owner]) {
    endGame(state, owner, 'surrender card drawn and will to fight broken');
  } else {
    state.log.push(`Surrender card drawn by ${owner}: the nation holds firm`);
  }
}

function draw(state, owner) {
  while (state.hands[owner].length < state.handSize && !state.over) {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) return;
      state.deck = shuffle(state, state.discard);
      state.discard = [];
    }
    const card = state.deck.pop();
    if (card.type === 'surrender') {
      state.discard.push(card);
      resolveSurrenderDraw(state, owner);
    } else {
      state.hands[owner].push(card);
    }
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
    gear: 0,
    braced: 0,
  }));
  const state = {
    cols: map.cols,
    rows: map.rows,
    // Columns up to borderCol are Player A's territory, the rest Player B's.
    borderCol: map.borderCol ?? Math.floor(map.cols / 2) - 1,
    terrain: { ...map.terrain },
    capitals: structuredClone(map.capitals),
    stacks,
    idCounters: counters,
    defense: {},
    defs: Object.fromEntries(config.cards.map((c) => [c.id, c])),
    doctrine: structuredClone(config.doctrine),
    levels: structuredClone(config.levels),
    maxLevel: config.maxLevel,
    handSize: config.handSize,
    cardsPerTurn: config.cardsPerTurn,
    rng: seed | 0,
    deck: [],
    discard: [],
    hands: { A: [], B: [] },
    played: 0,
    discardUsed: false,
    active: null,
    current: PLAYERS[0],
    turn: 1,
    casualties: { A: 0, B: 0 },
    battlesLost: { A: 0, B: 0 },
    resolve: { A: 0, B: 0 },
    surrender: { ...config.surrender },
    thresholds: {},
    over: null,
    pending: null,
    log: ['Game start. Player A moves first.'],
  };
  const { thresholdMin, thresholdMax, willingnessThreshold, publicResolve } = config.surrender;
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
  for (const def of config.cards) {
    for (let n = 1; n <= def.count; n++) state.deck.push({ uid: `${def.id}#${n}`, type: def.id });
  }
  shuffle(state, state.deck);
  for (const owner of PLAYERS) draw(state, owner);
  // Surrender cards join after the opening hands so nobody is checked before the war starts.
  for (let n = 1; n <= config.surrender.count; n++) state.deck.push({ uid: `surrender#${n}`, type: 'surrender' });
  shuffle(state, state.deck);
  return state;
}

export function inBounds(state, col, row) {
  return col >= 0 && row >= 0 && col < state.cols && row < state.rows;
}

export function terrainAt(state, col, row) {
  return state.terrain[key(col, row)] ?? 'open';
}

export function stackAt(state, col, row) {
  return state.stacks.find((s) => s.col === col && s.row === row);
}

export function getStack(state, id) {
  return state.stacks.find((s) => s.id === id);
}

export function strength(state, stack, defending) {
  if (!defending) return stack.men + stack.gear;
  const terrain = TERRAIN_BONUS[terrainAt(state, stack.col, stack.row)] ?? 0;
  const trenches = state.defense[key(stack.col, stack.row)] ?? 0;
  return stack.men + stack.gear + terrain + trenches + stack.braced;
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

// Can this stack be the subject of the given order card?
function eligible(state, def, stack) {
  const value = (field) => cardValue(state, stack.owner, def, field);
  switch (def.kind) {
    case 'move': return emptyNeighbors(state, stack).length > 0;
    case 'attack': return stack.men >= MIN_ATTACKER_MEN && adjacentStacks(state, stack, false).length > 0;
    case 'hold': return stack.braced < 1;
    case 'entrench': return (state.defense[key(stack.col, stack.row)] ?? 0) < value('limit');
    case 'rally': return stack.gear < value('limit');
    case 'martial': return stack.men >= 2;
    case 'merge': return adjacentStacks(state, stack, true).length > 0;
    case 'split': return stack.men >= 2 && emptyNeighbors(state, stack).length > 0;
    case 'posture': return stack.braced < value('amount');
    case 'propaganda': return true;
    default: return false;
  }
}

// Why a card cannot be played right now, or null if it can.
export function cardIssue(state, card) {
  const def = state.defs[card.type];
  if (state.over) return 'The game is over';
  if (state.pending) return 'Resolve the battle first';
  if (state.active) return 'Finish the current order first';
  if (state.played >= state.cardsPerTurn) return 'No card plays left this turn';
  const own = state.stacks.filter((s) => s.owner === state.current);
  if (!own.some((s) => eligible(state, def, s))) return 'No stack can use this order';
  return null;
}

export function playCard(state, uid) {
  const card = state.hands[state.current].find((c) => c.uid === uid);
  if (!card) throw new Error(`Card ${uid} is not in the current hand`);
  const issue = cardIssue(state, card);
  if (issue) throw new Error(issue);
  const next = structuredClone(state);
  const def = next.defs[card.type];
  const owner = next.current;
  const value = (field, fallback) => cardValue(next, owner, def, field, fallback);
  next.hands[owner] = next.hands[owner].filter((c) => c.uid !== uid);
  next.played += 1;
  if (IMMEDIATE.has(def.kind)) {
    const amount = value('amount');
    if (def.kind === 'posture') {
      for (const s of next.stacks) if (s.owner === owner) s.braced = Math.max(s.braced, amount);
      next.log.push(`${owner} plays ${def.name}: all stacks braced (+${amount})`);
    } else {
      next.resolve[owner] += amount;
      next.log.push(`${owner} plays ${def.name}: resolve +${amount}`);
    }
    next.discard.push(card);
    return next;
  }
  next.active = {
    card,
    kind: def.kind,
    charges: 1,
    points: value('points'),
    extraCost: def.extraCost ?? 0,
    used: [],
  };
  next.log.push(`${owner} plays ${def.name}`);
  return next;
}

function finishActive(next) {
  next.discard.push(next.active.card);
  next.active = null;
}

function consume(next, stackId) {
  next.active.charges -= 1;
  next.active.used.push(stackId);
  if (next.active.charges <= 0) finishActive(next);
}

function cancelActive(next) {
  if (next.active.used.length === 0) {
    next.hands[next.current].push(next.active.card);
    next.played -= 1;
    next.log.push(`${next.current} cancels ${next.defs[next.active.card.type].name}`);
    next.active = null;
  } else {
    next.log.push(`${next.current} ends ${next.defs[next.active.card.type].name}`);
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
  next.discard.push(card);
  next.discardUsed = true;
  next.log.push(`${next.current} discards ${next.defs[card.type].name}`);
  return next;
}

function activeFor(state, kind, stack) {
  const a = state.active;
  return a && !state.pending && !state.over && a.kind === kind && stack && stack.owner === state.current ? a : null;
}

// Stacks that can currently be chosen for the active order.
export function eligibleStacks(state) {
  const a = state.active;
  if (!a || state.pending || state.over) return [];
  return state.stacks.filter(
    (s) => s.owner === state.current && !a.used.includes(s.id) && eligible(state, state.defs[a.card.type], s),
  );
}

export function isDirectOrder(state) {
  return Boolean(state.active) && DIRECT.has(state.active.kind);
}

export function legalMoves(state, id) {
  const stack = getStack(state, id);
  return activeFor(state, 'move', stack) ? emptyNeighbors(state, stack) : [];
}

export function moveStack(state, id, col, row) {
  if (!legalMoves(state, id).some((m) => m.col === col && m.row === row)) {
    throw new Error(`Illegal move for ${id} to ${col},${row}`);
  }
  const next = structuredClone(state);
  const stack = getStack(next, id);
  next.log.push(`${id} moved (${stack.col},${stack.row}) -> (${col},${row})`);
  stack.col = col;
  stack.row = row;
  stack.braced = 0;
  consume(next, id);
  return next;
}

// Enemy stacks the given stack may attack. Attacking costs 1 man, so a lone man cannot.
export function legalAttacks(state, id) {
  const stack = getStack(state, id);
  const a = activeFor(state, 'attack', stack);
  if (!a || a.used.includes(id) || stack.men < MIN_ATTACKER_MEN) return [];
  return adjacentStacks(state, stack, false);
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
  state.casualties[stack.owner] += lost;
  return lost;
}

export function attack(state, attackerId, defenderId, bonus = 0) {
  if (!legalAttacks(state, attackerId).some((t) => t.id === defenderId)) {
    throw new Error(`Illegal attack ${attackerId} -> ${defenderId}`);
  }
  if (!Number.isInteger(bonus) || bonus < 0 || bonus > maxBonus(state)) {
    throw new Error(`Bonus ${bonus} is not affordable`);
  }
  const next = structuredClone(state);
  const attacker = getStack(next, attackerId);
  const defender = getStack(next, defenderId);
  const a = next.active;
  a.points -= bonus + (a.used.length ? a.extraCost : 0);
  // One more attack is possible only if the pool can pay for it; consume() then ends the order otherwise.
  a.charges = a.extraCost && a.points >= a.extraCost ? 2 : 1;
  const attackStrength = strength(next, attacker, false) + bonus;
  const defenseStrength = strength(next, defender, true);
  const verdict =
    attackStrength > defenseStrength ? 'attacker' : attackStrength < defenseStrength ? 'defender' : 'stalemate';

  // Attrition: every battle costs each side 1 man, whoever wins.
  attacker.braced = 0;
  loseMen(next, attacker, 1);
  loseMen(next, defender, 1);
  if (verdict === 'attacker') {
    attacker.gear += 1;
    next.battlesLost[defender.owner] += 1;
  } else if (verdict === 'defender') {
    defender.gear += 1;
    next.battlesLost[attacker.owner] += 1;
  }
  const battle = {
    attackerId,
    defenderId,
    winnerId: verdict === 'attacker' ? attackerId : null,
    loserId: defenderId,
    defenderCol: defender.col,
    defenderRow: defender.row,
  };
  const outcome = {
    attacker: `${attackerId} has the upper hand`,
    defender: `${defenderId} repels the attack`,
    stalemate: 'stalemate',
  }[verdict];
  next.log.push(
    `${attackerId} (${attackStrength}${bonus ? `, incl. +${bonus}` : ''}) attacks ${defenderId} (${defenseStrength}): ` +
      `${outcome}; each side loses 1 man.`,
  );
  // Only an attacker with the upper hand forces the surviving defender to choose.
  if (verdict === 'attacker' && defender.men > 0) next.pending = battle;
  else finishBattle(next, battle);
  consume(next, attackerId);
  return next;
}

// A retreat costs 1 gear, or 1 man if the stack has none, so it needs a chip to spare.
export function retreatOptions(state) {
  const pending = state.pending;
  if (!pending) return [];
  const loser = getStack(state, pending.loserId);
  const winner = getStack(state, pending.attackerId);
  if (loser.gear === 0 && loser.men < 2) return [];
  return emptyNeighbors(state, loser).filter((n) => distance(n, winner) > 1);
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
    next.log.push(`${attacker.id} advances to (${attacker.col},${attacker.row})`);
  }
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
  const cost = loser.gear > 0 ? '1 gear' : '1 man';
  if (loser.gear > 0) loser.gear -= 1;
  else loseMen(next, loser, 1);
  loser.col = col;
  loser.row = row;
  loser.braced = 0;
  next.log.push(`${loser.id} retreats to (${col},${row}), losing ${cost}`);
  finishBattle(next, pending);
  return next;
}

export function legalMerges(state, id) {
  const stack = getStack(state, id);
  return activeFor(state, 'merge', stack) ? adjacentStacks(state, stack, true) : [];
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
  next.stacks = next.stacks.filter((s) => s.id !== sourceId);
  next.log.push(`${sourceId} merges into ${targetId} (${target.men} men, ${target.gear} gear)`);
  consume(next, sourceId);
  return next;
}

export function legalSplits(state, id) {
  const stack = getStack(state, id);
  return activeFor(state, 'split', stack) && stack.men >= 2 ? emptyNeighbors(state, stack) : [];
}

export function splitStack(state, id, col, row) {
  if (!legalSplits(state, id).some((h) => h.col === col && h.row === row)) {
    throw new Error(`Illegal split of ${id} to ${col},${row}`);
  }
  const next = structuredClone(state);
  const stack = getStack(next, id);
  const sent = Math.floor(stack.men / 2);
  const def = next.defs[next.active.card.type];
  const gearSent = Math.min(stack.gear, cardValue(next, stack.owner, def, 'gear'));
  stack.men -= sent;
  stack.gear -= gearSent;
  const newId = `${stack.owner}${++next.idCounters[stack.owner]}`;
  next.stacks.push({ id: newId, owner: stack.owner, col, row, men: sent, gear: gearSent, braced: 0 });
  next.log.push(`${id} splits: ${newId} (${sent} men${gearSent ? `, ${gearSent} gear` : ''}) at (${col},${row})`);
  consume(next, id);
  return next;
}

// Applies a single-stack order (hold, entrench, rally, martial law) to the chosen stack.
export function applyToStack(state, id) {
  const stack = getStack(state, id);
  if (!isDirectOrder(state) || !eligibleStacks(state).some((s) => s.id === id) || !stack) {
    throw new Error(`Order cannot target ${id}`);
  }
  const next = structuredClone(state);
  const target = getStack(next, id);
  const def = next.defs[next.active.card.type];
  switch (next.active.kind) {
    case 'hold':
      target.braced = Math.max(target.braced, 1);
      next.log.push(`${id} digs in`);
      break;
    case 'entrench': {
      const k = key(target.col, target.row);
      next.defense[k] = (next.defense[k] ?? 0) + 1;
      next.log.push(`Trench built at (${target.col},${target.row})`);
      break;
    }
    case 'rally':
      target.gear += 1;
      next.log.push(`${id} rallies: +1 gear`);
      break;
    case 'martial': {
      const amount = cardValue(next, target.owner, def, 'amount');
      loseMen(next, target, 1);
      next.resolve[target.owner] += amount;
      next.log.push(`Martial law: ${id} loses 1 man, resolve +${amount}`);
      break;
    }
    default:
      throw new Error(`Unknown order ${next.active.kind}`);
  }
  consume(next, id);
  return next;
}

export function endTurn(state) {
  if (state.pending) throw new Error('Resolve the battle first');
  if (state.over) throw new Error('The game is over');
  const next = structuredClone(state);
  if (next.active) cancelActive(next);
  draw(next, next.current);
  if (next.over) return next;
  const index = PLAYERS.indexOf(next.current);
  next.current = PLAYERS[(index + 1) % PLAYERS.length];
  if (next.current === PLAYERS[0]) next.turn += 1;
  next.played = 0;
  next.discardUsed = false;
  for (const stack of next.stacks) if (stack.owner === next.current) stack.braced = 0;
  next.log.push(`Turn ${next.turn}: Player ${next.current}`);
  return next;
}
