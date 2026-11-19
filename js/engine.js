// Pure rules engine: every function takes a state and returns a new state.
// No DOM access, so it can run under Node for tests.
import { distance, key, neighbors } from './hex.js';

export const PLAYERS = ['A', 'B'];
export const TERRAIN_BONUS = { open: 0, rough: 1, fortified: 2 };
export const MIN_ATTACKER_MEN = 2;
export const HOLD_LOSS = 2;

export function createGame(map) {
  const counters = { A: 0, B: 0 };
  const stacks = map.stacks.map((s) => ({
    id: `${s.owner}${++counters[s.owner]}`,
    owner: s.owner,
    col: s.col,
    row: s.row,
    men: s.men,
    gear: 0,
    acted: false,
  }));
  return {
    cols: map.cols,
    rows: map.rows,
    terrain: { ...map.terrain },
    capitals: structuredClone(map.capitals),
    stacks,
    current: PLAYERS[0],
    turn: 1,
    casualties: { A: 0, B: 0 },
    battlesLost: { A: 0, B: 0 },
    pending: null,
    log: ['Game start. Player A moves first.'],
  };
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
  const terrain = defending ? TERRAIN_BONUS[terrainAt(state, stack.col, stack.row)] ?? 0 : 0;
  return stack.men + stack.gear + terrain;
}

function canAct(state, stack) {
  return Boolean(stack) && !state.pending && stack.owner === state.current && !stack.acted;
}

export function legalMoves(state, id) {
  const stack = getStack(state, id);
  if (!canAct(state, stack)) return [];
  return neighbors(stack.col, stack.row).filter(
    (n) => inBounds(state, n.col, n.row) && !stackAt(state, n.col, n.row),
  );
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
  stack.acted = true;
  return next;
}

// Enemy stacks the given stack may attack. Attacking costs 1 man, so a lone man cannot.
export function legalAttacks(state, id) {
  const stack = getStack(state, id);
  if (!canAct(state, stack) || stack.men < MIN_ATTACKER_MEN) return [];
  return neighbors(stack.col, stack.row)
    .map((n) => stackAt(state, n.col, n.row))
    .filter((target) => target && target.owner !== stack.owner);
}

function loseMen(state, stack, count) {
  const lost = Math.min(count, stack.men);
  stack.men -= lost;
  state.casualties[stack.owner] += lost;
  return lost;
}

export function attack(state, attackerId, defenderId) {
  if (!legalAttacks(state, attackerId).some((t) => t.id === defenderId)) {
    throw new Error(`Illegal attack ${attackerId} -> ${defenderId}`);
  }
  const next = structuredClone(state);
  const attacker = getStack(next, attackerId);
  const defender = getStack(next, defenderId);
  const attackStrength = strength(next, attacker, false);
  const defenseStrength = strength(next, defender, true);
  const attackerWins = attackStrength > defenseStrength; // ties go to the defender
  const winner = attackerWins ? attacker : defender;
  const loser = attackerWins ? defender : attacker;

  attacker.acted = true;
  loseMen(next, attacker, 1);
  winner.gear += 1;
  next.battlesLost[loser.owner] += 1;
  next.pending = {
    attackerId,
    defenderId,
    winnerId: winner.id,
    loserId: loser.id,
    defenderCol: defender.col,
    defenderRow: defender.row,
  };
  next.log.push(
    `${attackerId} (${attackStrength}) attacks ${defenderId} (${defenseStrength}): ${winner.id} wins. ` +
      `${loser.id} must hold or retreat.`,
  );
  return next;
}

export function retreatOptions(state) {
  const pending = state.pending;
  if (!pending) return [];
  const loser = getStack(state, pending.loserId);
  const winner = getStack(state, pending.winnerId);
  if (loser.men < 2) return []; // a retreat costs a man, which would destroy it
  return neighbors(loser.col, loser.row).filter(
    (n) =>
      inBounds(state, n.col, n.row) &&
      !stackAt(state, n.col, n.row) &&
      distance(n, winner) > 1,
  );
}

function finishBattle(next) {
  const pending = next.pending;
  next.stacks = next.stacks.filter((s) => s.men > 0);
  next.pending = null;
  // A winning attacker takes the hex if the defender left it or was destroyed.
  const attacker = getStack(next, pending.attackerId);
  if (
    attacker &&
    pending.winnerId === pending.attackerId &&
    !stackAt(next, pending.defenderCol, pending.defenderRow)
  ) {
    attacker.col = pending.defenderCol;
    attacker.row = pending.defenderRow;
    next.log.push(`${attacker.id} advances to (${attacker.col},${attacker.row})`);
  }
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
  next.log.push(`${loser.id} holds and loses ${lost} men${loser.men === 0 ? ' (destroyed)' : ''}`);
  finishBattle(next);
  return next;
}

export function resolveRetreat(state, col, row) {
  const pending = requirePending(state);
  if (!retreatOptions(state).some((o) => o.col === col && o.row === row)) {
    throw new Error(`Illegal retreat to ${col},${row}`);
  }
  const next = structuredClone(state);
  const loser = getStack(next, pending.loserId);
  loseMen(next, loser, 1);
  const gearLost = Math.min(1, loser.gear);
  loser.gear -= gearLost;
  loser.col = col;
  loser.row = row;
  next.log.push(`${loser.id} retreats to (${col},${row}), losing 1 man${gearLost ? ' and 1 gear' : ''}`);
  finishBattle(next);
  return next;
}

export function endTurn(state) {
  if (state.pending) throw new Error('Resolve the battle first');
  const next = structuredClone(state);
  const index = PLAYERS.indexOf(next.current);
  next.current = PLAYERS[(index + 1) % PLAYERS.length];
  if (next.current === PLAYERS[0]) next.turn += 1;
  for (const stack of next.stacks) stack.acted = false;
  next.log.push(`Turn ${next.turn}: Player ${next.current}`);
  return next;
}
