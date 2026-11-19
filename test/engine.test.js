import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGame, endTurn, inBounds, legalMoves, moveStack, stackAt } from '../js/engine.js';
import { neighbors } from '../js/hex.js';

const map = JSON.parse(readFileSync(new URL('../data/map.json', import.meta.url)));

test('neighbor relation is symmetric on every hex', () => {
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      for (const n of neighbors(col, row)) {
        const back = neighbors(n.col, n.row);
        assert.ok(back.some((b) => b.col === col && b.row === row), `${col},${row} <-> ${n.col},${n.row}`);
      }
    }
  }
});

test('map data places 5 stacks per side on distinct in-bounds hexes', () => {
  const state = createGame(map);
  assert.equal(state.stacks.filter((s) => s.owner === 'A').length, 5);
  assert.equal(state.stacks.filter((s) => s.owner === 'B').length, 5);
  const seen = new Set(state.stacks.map((s) => `${s.col},${s.row}`));
  assert.equal(seen.size, 10);
  for (const s of state.stacks) assert.ok(inBounds(state, s.col, s.row));
});

test('legal moves exclude off-map and occupied hexes', () => {
  const state = createGame(map);
  for (const stack of state.stacks.filter((s) => s.owner === 'A')) {
    for (const m of legalMoves(state, stack.id)) {
      assert.ok(inBounds(state, m.col, m.row));
      assert.equal(stackAt(state, m.col, m.row), undefined);
    }
  }
});

test('a stack moves once per turn and only for the current player', () => {
  let state = createGame(map);
  const [target] = legalMoves(state, 'A1');
  state = moveStack(state, 'A1', target.col, target.row);
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [target.col, target.row]);
  assert.deepEqual(legalMoves(state, 'A1'), []);
  assert.deepEqual(legalMoves(state, 'B1'), []);
  assert.throws(() => moveStack(state, 'A1', target.col, target.row));
});

test('ending the turn switches player, resets actions and counts turns', () => {
  let state = createGame(map);
  const [target] = legalMoves(state, 'A1');
  state = endTurn(moveStack(state, 'A1', target.col, target.row));
  assert.equal(state.current, 'B');
  assert.equal(state.turn, 1);
  assert.ok(legalMoves(state, 'B1').length > 0);
  state = endTurn(state);
  assert.equal(state.current, 'A');
  assert.equal(state.turn, 2);
  assert.ok(legalMoves(state, 'A1').length > 0);
});
