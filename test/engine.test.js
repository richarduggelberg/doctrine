import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyToStack, attack, breakScore, cardIssue, createGame, discardCard, eligibleStacks, endOrder, endTurn,
  inBounds, legalAttacks, legalMerges, legalMoves, legalSplits, mergeStacks, moveStack, playCard,
  resolveHold, resolveRetreat, retreatOptions, splitStack, stackAt, strength, territoryOf,
} from '../js/engine.js';
import { distance, neighbors } from '../js/hex.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const map = read('../data/map.json');
const config = read('../data/cards.json');

// Put a specific card in the current player's hand (cards are otherwise random).
function give(state, type) {
  const next = structuredClone(state);
  next.hands[next.current].push({ uid: `test-${type}-${next.hands[next.current].length}`, type });
  return next;
}

function play(state, type) {
  const given = give(state, type);
  return playCard(given, given.hands[given.current].at(-1).uid);
}

// Override suit counts in a player's doctrine.
function setDoctrine(state, owner, cards) {
  const next = structuredClone(state);
  Object.assign(next.doctrine[owner].cards, cards);
  return next;
}

// Tiny map: A1 at (1,2) next to B1 at (2,2).
function duel(a, b, terrain = {}) {
  return createGame(
    {
      cols: 7,
      rows: 5,
      borderCol: 1,
      terrain,
      capitals: { A: { col: 0, row: 0 }, B: { col: 6, row: 4 } },
      stacks: [
        { owner: 'A', col: 1, row: 2, men: a },
        { owner: 'B', col: 2, row: 2, men: b },
      ],
    },
    config,
  );
}

const fight = (a, b, card = 'attack', terrain = {}) => attack(play(duel(a, b, terrain), card), 'A1', 'B1');

test('neighbor relation is symmetric and distance matches adjacency', () => {
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      for (const n of neighbors(col, row)) {
        assert.ok(neighbors(n.col, n.row).some((b) => b.col === col && b.row === row));
        assert.equal(distance({ col, row }, n), 1);
      }
    }
  }
});

test('setup: 5 stacks per side, 5-card hands, and a seeded deck', () => {
  const state = createGame(map, config, 42);
  assert.equal(state.stacks.filter((s) => s.owner === 'A').length, 5);
  assert.equal(state.stacks.filter((s) => s.owner === 'B').length, 5);
  assert.equal(new Set(state.stacks.map((s) => `${s.col},${s.row}`)).size, 10);
  for (const s of state.stacks) assert.ok(inBounds(state, s.col, s.row));
  assert.equal(state.hands.A.length, 5);
  assert.equal(state.hands.B.length, 5);
  const total = config.cards.reduce((n, c) => n + c.count, 0) + config.surrender.count;
  assert.equal(state.deck.length + 10, total);
  for (const p of ['A', 'B']) {
    assert.ok(state.hands[p].every((c) => c.type !== 'surrender'));
    assert.ok(state.thresholds[p] >= 8);
  }
  assert.deepEqual(createGame(map, config, 42).hands, state.hands);
  assert.notDeepEqual(createGame(map, config, 43).hands, state.hands);
});

test('armies start in their own territory on the front line, out of contact', () => {
  const state = createGame(map, config, 1);
  for (const s of state.stacks) {
    assert.equal(territoryOf(state, s.col), s.owner);
    assert.ok(Math.abs(s.col - state.borderCol - 0.5) <= 1.5, `${s.id} is on the front line`);
    assert.equal(s.men, 5);
  }
  const gap = Math.min(
    ...state.stacks.filter((s) => s.owner === 'A').flatMap((a) =>
      state.stacks.filter((s) => s.owner === 'B').map((b) => distance(a, b))),
  );
  assert.ok(gap >= 2, 'no stacks adjacent at the start');
  assert.equal(territoryOf(state, state.capitals.A.col), 'A');
  assert.equal(territoryOf(state, state.capitals.B.col), 'B');
});

test('nothing can be done without playing an order card', () => {
  const state = createGame(map, config, 1);
  assert.deepEqual(legalMoves(state, 'A1'), []);
  assert.deepEqual(legalAttacks(state, 'A1'), []);
});

test('every card is playable by either doctrine; the suit level sets its magnitude', () => {
  const state = duel(3, 3);
  const aOffensive = give(state, 'offensive');
  assert.equal(cardIssue(aOffensive, aOffensive.hands.A.at(-1)), null);
  assert.equal(play(state, 'offensive').active.bonus, 3); // A: 3 aggressive cards
  assert.equal(play(setDoctrine(state, 'A', { aggressive: 1 }), 'offensive').active.bonus, 1);
  assert.equal(play(setDoctrine(state, 'A', { aggressive: 0 }), 'offensive').active.bonus, 0);
  assert.equal(play(setDoctrine(state, 'A', { aggressive: 9 }), 'offensive').active.bonus, 3, 'level is capped');
  const bOffensive = give(endTurn(state), 'offensive');
  assert.equal(cardIssue(bOffensive, bOffensive.hands.B.at(-1)), null);
  assert.equal(play(endTurn(state), 'offensive').active.bonus, 0); // B: no aggressive cards
});

test('doctrine sets hidden thresholds (willingness) and the declared-doctrine resolve bonus', () => {
  const state = createGame(map, config, 11);
  const { thresholdMin, thresholdMax, willingnessThreshold, publicResolve } = config.surrender;
  const bonus = config.doctrine.B.cards.willingness * willingnessThreshold;
  assert.ok(state.thresholds.A >= thresholdMin && state.thresholds.A <= thresholdMax);
  assert.ok(state.thresholds.B >= thresholdMin + bonus && state.thresholds.B <= thresholdMax + bonus);
  assert.deepEqual(state.resolve, { A: publicResolve, B: publicResolve });
  const secret = structuredClone(config);
  secret.doctrine.A.public = false;
  assert.deepEqual(createGame(map, secret, 11).resolve, { A: 0, B: publicResolve });
});

test('a card needing an unavailable stack cannot be played', () => {
  const lone = give(duel(1, 1), 'attack');
  assert.match(cardIssue(lone, lone.hands.A.at(-1)), /No stack/);
});

test('a Move card moves one stack once and is then discarded', () => {
  let state = play(duel(3, 3), 'move');
  const [target] = legalMoves(state, 'A1');
  state = moveStack(state, 'A1', target.col, target.row);
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [target.col, target.row]);
  assert.equal(state.active, null);
  assert.equal(state.played, 1);
  assert.deepEqual(legalMoves(state, 'A1'), []);
  assert.equal(state.discard.at(-1).type, 'move');
});

test('only two cards can be played per turn', () => {
  let state = duel(3, 3);
  for (let i = 0; i < 2; i++) {
    state = play(state, 'move');
    const [target] = legalMoves(state, 'A1');
    state = moveStack(state, 'A1', target.col, target.row);
  }
  state = give(state, 'move');
  assert.match(cardIssue(state, state.hands.A.at(-1)), /plays left/);
});

test('cancelling an unused order refunds the card and the play', () => {
  const armed = play(duel(3, 3), 'move');
  assert.equal(armed.played, 1);
  const cancelled = endOrder(armed);
  assert.equal(cancelled.played, 0);
  assert.equal(cancelled.active, null);
  assert.ok(cancelled.hands.A.some((c) => c.type === 'move'));
});

test('ties go to the defender; terrain, trenches and bracing add to defense', () => {
  assert.equal(fight(3, 3).pending.winnerId, 'B1');
  const rough = duel(4, 3, { '2,2': 'rough' });
  assert.equal(strength(rough, rough.stacks[1], true), 4);
  assert.equal(attack(play(rough, 'attack'), 'A1', 'B1').pending.winnerId, 'B1');
  const braced = structuredClone(duel(4, 3));
  braced.stacks[1].braced = 1;
  braced.defense['2,2'] = 2;
  assert.equal(strength(braced, braced.stacks[1], true), 6);
});

test('Offensive adds its doctrine bonus to the attack', () => {
  assert.equal(fight(3, 3, 'offensive').pending.winnerId, 'A1');
  const weak = attack(play(setDoctrine(duel(3, 3), 'A', { aggressive: 0 }), 'offensive'), 'A1', 'B1');
  assert.equal(weak.pending.winnerId, 'B1'); // +0: a tie, defender wins
});

test('winning attacker loses 1 man, gains gear, and advances when the defender retreats', () => {
  let state = fight(5, 3);
  assert.equal(state.pending.winnerId, 'A1');
  assert.equal(state.stacks[0].men, 4);
  assert.equal(state.stacks[0].gear, 1);
  const options = retreatOptions(state);
  assert.ok(options.length > 0);
  for (const o of options) assert.ok(distance(o, state.stacks[0]) > 1);
  state = resolveRetreat(state, options[0].col, options[0].row);
  assert.equal(state.stacks.find((s) => s.id === 'B1').men, 2);
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [2, 2]);
  assert.equal(state.pending, null);
  assert.equal(state.battlesLost.B, 1);
  assert.equal(state.casualties.A + state.casualties.B, 2);
});

test('holding costs 2 men and the defender keeps its hex; destroyed stacks vanish', () => {
  const held = resolveHold(fight(5, 4));
  assert.equal(held.stacks.find((s) => s.id === 'B1').men, 2);
  assert.deepEqual([held.stacks[0].col, held.stacks[0].row], [1, 2]);
  const destroyed = resolveHold(fight(6, 2));
  assert.equal(destroyed.stacks.length, 1);
  assert.deepEqual([destroyed.stacks[0].col, destroyed.stacks[0].row], [2, 2]);
});

test('a stack too small to survive a retreat must hold; a losing attacker never advances', () => {
  const small = fight(5, 1);
  assert.deepEqual(retreatOptions(small), []);
  assert.throws(() => resolveRetreat(small, 3, 2));
  const lost = fight(2, 5);
  assert.equal(lost.pending.loserId, 'A1');
  const done = resolveHold(lost);
  assert.deepEqual([done.stacks[0].col, done.stacks[0].row], [2, 2]);
});

test('other actions are blocked while a battle awaits a decision', () => {
  const state = fight(5, 3);
  assert.throws(() => endTurn(state));
  assert.throws(() => attack(state, 'A1', 'B1'));
});

test('Double Offensive allows two different stacks to attack, not the same one twice', () => {
  const state = createGame(
    {
      cols: 7,
      rows: 5,
      terrain: {},
      capitals: { A: { col: 0, row: 0 }, B: { col: 6, row: 4 } },
      stacks: [
        { owner: 'A', col: 1, row: 2, men: 6 },
        { owner: 'A', col: 2, row: 3, men: 6 },
        { owner: 'B', col: 2, row: 2, men: 2 },
        { owner: 'B', col: 3, row: 3, men: 2 },
      ],
    },
    config,
  );
  let s = attack(play(setDoctrine(state, 'A', { aggressive: 2 }), 'double'), 'A1', 'B1');
  s = resolveHold(s); // B1 destroyed
  assert.equal(s.active.charges, 1);
  assert.deepEqual(legalAttacks(s, 'A1'), []);
  assert.ok(eligibleStacks(s).every((st) => st.id !== 'A1'));
  s = attack(s, 'A2', 'B2');
  assert.equal(s.active, null);
});

test('Entrench adds trench chips up to the doctrine limit per hex', () => {
  let state = endTurn(duel(3, 3));
  state = applyToStack(play(state, 'entrench'), 'B1');
  assert.equal(state.defense['2,2'], 1);
  const limit = 3; // B has 3 defensive cards
  state.defense['2,2'] = limit - 1;
  state.played = 0;
  const almost = give(state, 'entrench');
  assert.equal(cardIssue(almost, almost.hands.B.at(-1)), null);
  state.defense['2,2'] = limit;
  const full = give(state, 'entrench');
  assert.match(cardIssue(full, full.hands.B.at(-1)), /No stack/);
  const lowLevel = setDoctrine(full, 'B', { defensive: 1 });
  lowLevel.defense['2,2'] = 2;
  assert.match(cardIssue(lowLevel, lowLevel.hands.B.at(-1)), /No stack/);
});

test('Hold braces a stack until its owner next turn; moving removes the bracing', () => {
  let state = applyToStack(play(duel(3, 3), 'hold'), 'A1');
  assert.equal(state.stacks[0].braced, 1);
  state = endTurn(state);
  assert.equal(state.stacks[0].braced, 1);
  state = endTurn(state);
  assert.equal(state.stacks[0].braced, 0);
  const braced = applyToStack(play(duel(3, 3), 'hold'), 'A1');
  const moved = moveStack(play(braced, 'move'), 'A1', 1, 1);
  assert.equal(moved.stacks[0].braced, 0);
});

test('Merge combines stacks; Split sends half to an empty hex', () => {
  const base = createGame(
    {
      cols: 7,
      rows: 5,
      terrain: {},
      capitals: { A: { col: 0, row: 0 }, B: { col: 6, row: 4 } },
      stacks: [
        { owner: 'A', col: 1, row: 2, men: 5 },
        { owner: 'A', col: 2, row: 2, men: 2 },
        { owner: 'B', col: 6, row: 2, men: 3 },
      ],
    },
    config,
  );
  const merged = mergeStacks(play(base, 'merge'), 'A2', 'A1');
  assert.equal(merged.stacks.find((s) => s.id === 'A1').men, 7);
  assert.equal(merged.stacks.filter((s) => s.owner === 'A').length, 1);
  assert.deepEqual(legalMerges(play(base, 'merge'), 'A1').map((s) => s.id), ['A2']);

  const armed = play(base, 'split');
  const [hex] = legalSplits(armed, 'A1');
  const split = splitStack(armed, 'A1', hex.col, hex.row);
  assert.equal(split.stacks.find((s) => s.id === 'A1').men, 3);
  assert.equal(stackAt(split, hex.col, hex.row).men, 2);
  assert.equal(stackAt(split, hex.col, hex.row).id, 'A3');
  assert.equal(stackAt(split, hex.col, hex.row).gear, 0);

  // At level 3 a split can take one gear chip along.
  const geared = setDoctrine(base, 'A', { reorganizational: 3 });
  geared.stacks[0].gear = 2;
  const armedGear = play(geared, 'split');
  const sent = splitStack(armedGear, 'A1', hex.col, hex.row);
  assert.equal(stackAt(sent, hex.col, hex.row).gear, 1);
  assert.equal(sent.stacks.find((s) => s.id === 'A1').gear, 1);
});

test('Rally, Propaganda, Defensive Posture and Martial Law scale with doctrine', () => {
  let state = applyToStack(play(duel(3, 3), 'rally'), 'A1');
  assert.equal(state.stacks[0].gear, 1);
  state = endTurn(duel(3, 3)); // Player B: 2 willingness cards, 3 defensive cards
  const before = state.resolve.B;
  const propaganda = play(state, 'propaganda');
  assert.equal(propaganda.resolve.B, before + 4);
  assert.equal(propaganda.active, null);
  assert.equal(play(setDoctrine(state, 'B', { willingness: 0 }), 'propaganda').resolve.B, before + 2);
  const posture = play(state, 'posture');
  assert.ok(posture.stacks.filter((s) => s.owner === 'B').every((s) => s.braced === 3));
  const martial = applyToStack(play(state, 'martial'), 'B1');
  assert.equal(martial.stacks.find((s) => s.id === 'B1').men, 2);
  assert.equal(martial.resolve.B, before + 5);
  assert.equal(martial.casualties.B, 1);
});

test('ending a turn refills the hand, resets plays and switches player', () => {
  let state = createGame(map, config, 7);
  state = discardCard(state, state.hands.A[0].uid);
  assert.equal(state.hands.A.length, 4);
  assert.throws(() => discardCard(state, state.hands.A[0].uid));
  state = endTurn(state);
  assert.equal(state.current, 'B');
  assert.equal(state.hands.A.length, 5);
  assert.equal(state.played, 0);
  assert.equal(state.discardUsed, false);
  state = endTurn(state);
  assert.equal(state.current, 'A');
  assert.equal(state.turn, 2);
});

test('the discard pile is reshuffled when the deck runs out', () => {
  let state = createGame(map, config, 3);
  const turns = 60; // each turn draws 1 card from a 27-card deck, so discards must be reshuffled
  for (let i = 0; i < turns; i++) {
    state = discardCard(state, state.hands[state.current][0].uid);
    state = endTurn(state);
  }
  assert.equal(state.hands.A.length, 5);
  assert.equal(state.hands.B.length, 5);
  const all = [...state.deck, ...state.discard, ...state.hands.A, ...state.hands.B].map((c) => c.uid);
  assert.equal(new Set(all).size, all.length);
});

// Rig the deck so the current player's next draw is a surrender card.
function rigSurrender(state) {
  const next = structuredClone(state);
  next.hands[next.current].pop();
  next.deck.push({ uid: 'surrender#rigged', type: 'surrender' });
  return next;
}

test('break score counts casualties, lost battles and lost home ground, minus resolve', () => {
  let state = duel(3, 3);
  state.resolve.A = 0; // ignore the declared-doctrine bonus
  assert.equal(breakScore(state, 'A'), 0);
  state.casualties.A = 4;
  state.battlesLost.A = 1;
  assert.equal(breakScore(state, 'A'), 6);
  state.stacks.find((s) => s.id === 'B1').col = 1; // enemy on A's starting hex (1,2)
  state.stacks.find((s) => s.id === 'A1').col = 3;
  assert.equal(breakScore(state, 'A'), 7);
  state.stacks.find((s) => s.id === 'B1').col = 0;
  state.stacks.find((s) => s.id === 'B1').row = 0; // enemy on A's capital
  assert.equal(breakScore(state, 'A'), 6 + config.surrender.capitalWeight);
  state.resolve.A = 100;
  assert.equal(breakScore(state, 'A'), 0);
});

test('a surrender card breaks only the drawer, and only above their threshold', () => {
  let state = createGame(map, config, 5);
  state.casualties.A = 50; // A is far past any threshold, B is untouched
  state = endTurn(rigSurrender(state));
  assert.equal(state.over.loser, 'A');
  assert.equal(state.over.winner, 'B');
  assert.deepEqual(state.thresholds, state.over.thresholds);
  assert.throws(() => endTurn(state));
  assert.throws(() => discardCard(state, state.hands.A[0].uid));
  assert.ok(state.hands.A.every((c) => cardIssue(state, c) === 'The game is over'));
});

test('a surrender card is harmless to a nation that still holds firm, and is recycled', () => {
  let state = createGame(map, config, 5);
  state.casualties.B = 50; // only the opponent is broken
  state = endTurn(rigSurrender(state));
  assert.equal(state.over, null);
  assert.equal(state.hands.A.length, 5);
  assert.ok(state.hands.A.every((c) => c.type !== 'surrender'));
  assert.ok(state.discard.some((c) => c.type === 'surrender'));
  assert.equal(state.current, 'B');
});

test('a nation with no stacks left surrenders at once', () => {
  let state = duel(3, 1);
  state = attack(play(state, 'attack'), 'A1', 'B1');
  state = resolveHold(state);
  assert.equal(state.over.loser, 'B');
  assert.match(state.over.reason, /destroyed/);
});
