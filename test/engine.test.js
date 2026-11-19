import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  attack, createGame, endTurn, inBounds, legalAttacks, legalMoves, moveStack,
  resolveHold, resolveRetreat, retreatOptions, stackAt, strength,
} from '../js/engine.js';
import { distance, neighbors } from '../js/hex.js';

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

test('hex distance is 1 for every neighbor and 2 for neighbors of neighbors', () => {
  for (const n of neighbors(3, 3)) {
    assert.equal(distance({ col: 3, row: 3 }, n), 1);
    for (const m of neighbors(n.col, n.row)) {
      assert.ok(distance({ col: 3, row: 3 }, m) <= 2);
    }
  }
});

// Combat tests use a tiny custom map: A1 at (1,2) next to B1 at (2,2).
function duel(a, b, terrain = {}) {
  return createGame({
    cols: 7,
    rows: 5,
    terrain,
    capitals: { A: { col: 0, row: 0 }, B: { col: 6, row: 4 } },
    stacks: [
      { owner: 'A', col: 1, row: 2, men: a },
      { owner: 'B', col: 2, row: 2, men: b },
    ],
  });
}

test('a lone man cannot attack', () => {
  assert.deepEqual(legalAttacks(duel(1, 1), 'A1'), []);
});

test('ties go to the defender and terrain adds to defense strength', () => {
  const tie = attack(duel(3, 3), 'A1', 'B1');
  assert.equal(tie.pending.winnerId, 'B1');
  const rough = duel(4, 3, { '2,2': 'rough' });
  assert.equal(strength(rough, rough.stacks[1], true), 4);
  assert.equal(attack(rough, 'A1', 'B1').pending.winnerId, 'B1');
});

test('winning attacker loses 1 man, gains gear, and advances when the defender retreats', () => {
  let state = attack(duel(5, 3), 'A1', 'B1');
  assert.equal(state.pending.winnerId, 'A1');
  assert.equal(state.stacks[0].men, 4);
  assert.equal(state.stacks[0].gear, 1);
  const options = retreatOptions(state);
  assert.ok(options.length > 0);
  for (const o of options) assert.ok(distance(o, state.stacks[0]) > 1);
  state = resolveRetreat(state, options[0].col, options[0].row);
  const b1 = state.stacks.find((s) => s.id === 'B1');
  assert.equal(b1.men, 2);
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [2, 2]);
  assert.equal(state.pending, null);
  assert.equal(state.battlesLost.B, 1);
  assert.equal(state.casualties.A + state.casualties.B, 2);
});

test('holding costs 2 men and the defender keeps its hex', () => {
  const state = resolveHold(attack(duel(5, 4), 'A1', 'B1'));
  assert.equal(state.stacks.find((s) => s.id === 'B1').men, 2);
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [1, 2]);
});

test('a destroyed defender is removed and the attacker takes the hex', () => {
  const state = resolveHold(attack(duel(6, 2), 'A1', 'B1'));
  assert.equal(state.stacks.length, 1);
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [2, 2]);
});

test('a stack too small to survive a retreat must hold', () => {
  const state = attack(duel(5, 1), 'A1', 'B1');
  assert.deepEqual(retreatOptions(state), []);
  assert.throws(() => resolveRetreat(state, 3, 2));
});

test('a losing attacker pays too; defender never advances', () => {
  const state = attack(duel(2, 5), 'A1', 'B1');
  assert.equal(state.pending.loserId, 'A1');
  assert.equal(state.stacks[1].gear, 1);
  const done = resolveHold(state);
  assert.equal(done.stacks.length, 1);
  assert.deepEqual([done.stacks[0].col, done.stacks[0].row], [2, 2]);
});

test('other actions are blocked while a battle awaits a decision', () => {
  const state = attack(duel(5, 3), 'A1', 'B1');
  assert.throws(() => endTurn(state));
  assert.deepEqual(legalMoves(state, 'A1'), []);
  assert.throws(() => attack(state, 'A1', 'B1'));
});
