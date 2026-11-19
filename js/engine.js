// Pure rules engine: every function takes a state and returns a new state.
// No DOM access, so it can run under Node for tests.
import { key, neighbors } from './hex.js';

export const PLAYERS = ['A', 'B'];

export function createGame(map) {
  const counters = { A: 0, B: 0 };
  const stacks = map.stacks.map((s) => ({
    id: `${s.owner}${++counters[s.owner]}`,
    owner: s.owner,
    col: s.col,
    row: s.row,
    men: s.men,
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

export function legalMoves(state, id) {
  const stack = getStack(state, id);
  if (!stack || stack.owner !== state.current || stack.acted) return [];
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

export function endTurn(state) {
  const next = structuredClone(state);
  const index = PLAYERS.indexOf(next.current);
  next.current = PLAYERS[(index + 1) % PLAYERS.length];
  if (next.current === PLAYERS[0]) next.turn += 1;
  for (const stack of next.stacks) stack.acted = false;
  next.log.push(`Turn ${next.turn}: Player ${next.current}`);
  return next;
}
