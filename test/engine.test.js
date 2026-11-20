import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyPool, applyToStack, attack, breakScore, cardIssue, chooseMode, createGame, discardCard, eligibleStacks, endOrder,
  endTurn, inBounds, inEnemyZoc, legalAssaults, legalAttacks, legalMerges, legalMoves, legalSplits, maxBonus, mergeStacks,
  moveStack, playCard, resolveHold, resolveRetreat, retreatOptions, splitStack, stackAt, strength, territoryOf,
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

// Like duel, but one empty hex (2,2) lies between the stacks: an attack must be an assault.
function gapDuel(a, b) {
  const state = duel(a, b);
  state.stacks[1].col = 3;
  return state;
}
const ENTRY = { col: 2, row: 2 };
const assault = (a, b, card = 'attack', pay = false, bonus = 0) =>
  attack(play(gapDuel(a, b), card), 'A1', 'B1', bonus, ENTRY, pay);

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

test('attacking needs an order card, but moving does not', () => {
  const state = duel(3, 3);
  assert.deepEqual(legalAttacks(state, 'A1'), []);
  assert.ok(legalMoves(state, 'A1').length > 0);
});

test('every card is playable by either doctrine; the suit level sets its magnitude', () => {
  const state = duel(3, 3);
  const aOffensive = give(state, 'offensive');
  assert.equal(cardIssue(aOffensive, aOffensive.hands.A.at(-1)), null);
  assert.equal(play(state, 'offensive').active.points, 3); // A: 3 aggressive cards
  assert.equal(play(setDoctrine(state, 'A', { aggressive: 1 }), 'offensive').active.points, 1);
  assert.equal(play(setDoctrine(state, 'A', { aggressive: 0 }), 'offensive').active.points, 0);
  assert.equal(play(setDoctrine(state, 'A', { aggressive: 9 }), 'offensive').active.points, 3, 'level is capped');
  const bOffensive = give(endTurn(state), 'offensive');
  assert.equal(cardIssue(bOffensive, bOffensive.hands.B.at(-1)), null);
  assert.equal(play(endTurn(state), 'offensive').active.points, 0); // B: no aggressive cards
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

test('a stack steps 1 hex per turn outside enemy zones; the step resets next turn; rail adds hexes', () => {
  let state = duel(3, 3); // A1 (1,2) touches B1 (2,2)
  const open = legalMoves(state, 'A1').map((h) => `${h.col},${h.row}`);
  assert.ok(open.includes('0,2'));
  assert.ok(!open.includes('1,1') && !open.includes('1,3'), 'hexes next to the enemy are in its zone');
  state = moveStack(state, 'A1', 0, 2);
  assert.deepEqual(legalMoves(state, 'A1'), []);
  assert.throws(() => moveStack(state, 'A1', 0, 1));
  assert.equal(state.played, 0, 'moving costs no card');
  state = endTurn(endTurn(state));
  assert.ok(legalMoves(state, 'A1').length > 0);

  let railed = chooseMode(play(duel(3, 3), 'logistics'), 'rail'); // A: reorganizational 2 = 2 points
  railed = applyToStack(railed, 'A1');
  assert.equal(railed.active.points, 1);
  railed = moveStack(railed, 'A1', 0, 2);
  assert.ok(legalMoves(railed, 'A1').length > 0, 'rail gives a second hex');
  assert.equal(legalMoves(moveStack(duel(3, 3), 'A1', 0, 2), 'B1').length, 0, 'only the current player moves');
});

test('only two cards can be played per turn', () => {
  let state = play(play(duel(3, 3), 'posture'), 'elastic'); // two immediate cards
  state = give(state, 'hold');
  assert.match(cardIssue(state, state.hands.A.at(-1)), /plays left/);
});

test('cancelling an unused order refunds the card and the play', () => {
  const armed = play(duel(3, 3), 'hold');
  assert.equal(armed.played, 1);
  const cancelled = endOrder(armed);
  assert.equal(cancelled.played, 0);
  assert.equal(cancelled.active, null);
  assert.ok(cancelled.hands.A.some((c) => c.type === 'hold'));
});

test('terrain, trenches and bracing add to defense; a tie is a stalemate with attrition only', () => {
  const tie = fight(3, 3);
  assert.equal(tie.pending, null);
  assert.deepEqual(tie.stacks.map((s) => [s.men, s.col]), [[2, 1], [2, 2]]);
  assert.deepEqual(tie.battlesLost, { A: 0, B: 0 });
  assert.equal(tie.casualties.A + tie.casualties.B, 2);
  const rough = duel(4, 3, { '2,2': 'rough' });
  assert.equal(strength(rough, rough.stacks[1], true), 4);
  assert.equal(attack(play(rough, 'attack'), 'A1', 'B1').pending, null);
  const braced = structuredClone(duel(4, 3));
  braced.stacks[1].braced = 1;
  braced.defense['2,2'] = 2;
  assert.equal(strength(braced, braced.stacks[1], true), 6);
});

test('Offensive with no aggressive doctrine is only a basic attack', () => {
  assert.equal(maxBonus(play(setDoctrine(duel(3, 3), 'A', { aggressive: 0 }), 'offensive')), 0);
});

test('a repulsed attacker pays only attrition, the defender gains gear and nobody has to choose', () => {
  const state = fight(3, 5);
  assert.equal(state.pending, null);
  assert.equal(state.stacks.find((s) => s.id === 'A1').men, 2);
  const defender = state.stacks.find((s) => s.id === 'B1');
  assert.deepEqual([defender.men, defender.gear, defender.col], [4, 1, 2]);
  assert.deepEqual(state.battlesLost, { A: 1, B: 0 });
});

test('with the upper hand the attacker gains gear; the defender loses a man and may retreat', () => {
  let state = fight(5, 3);
  assert.equal(state.pending.winnerId, 'A1');
  assert.equal(state.stacks[0].men, 4);
  assert.equal(state.stacks[0].gear, 1);
  assert.equal(state.stacks[1].men, 2); // attrition
  const options = retreatOptions(state);
  assert.ok(options.length > 0);
  for (const o of options) assert.ok(!inEnemyZoc(state, 'B', o.col, o.row), 'a retreat must leave every enemy zone');
  state = resolveRetreat(state, options[0].col, options[0].row);
  assert.equal(state.stacks.find((s) => s.id === 'B1').men, 1); // no gear: the retreat costs a man
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [2, 2]);
  assert.equal(state.pending, null);
  assert.equal(state.battlesLost.B, 1);
  assert.equal(state.casualties.A + state.casualties.B, 3);
});

test('a retreat costs gear before men', () => {
  const geared = play(duel(5, 3), 'attack');
  geared.stacks[1].gear = 1;
  const state = attack(geared, 'A1', 'B1');
  const [hex] = retreatOptions(state);
  const retreated = resolveRetreat(state, hex.col, hex.row).stacks.find((s) => s.id === 'B1');
  assert.deepEqual([retreated.men, retreated.gear], [2, 0]);
});

test('standing costs 1 more man (2 in total) and keeps the hex; destroyed stacks vanish', () => {
  const held = resolveHold(fight(5, 4));
  assert.equal(held.stacks.find((s) => s.id === 'B1').men, 2);
  assert.deepEqual([held.stacks[0].col, held.stacks[0].row], [1, 2]);
  const destroyed = resolveHold(fight(6, 2));
  assert.equal(destroyed.stacks.length, 1);
  assert.deepEqual([destroyed.stacks[0].col, destroyed.stacks[0].row], [2, 2]);
  const attrition = fight(6, 1); // attrition alone destroys a lone man, no decision needed
  assert.equal(attrition.pending, null);
  assert.deepEqual([attrition.stacks.length, attrition.stacks[0].col], [1, 2]);
});

test('a stack with no chip to spare cannot retreat', () => {
  const small = fight(5, 2); // 1 man, no gear left after attrition
  assert.deepEqual(retreatOptions(small), []);
  assert.throws(() => resolveRetreat(small, 3, 2));
});

test('other actions are blocked while a battle awaits a decision', () => {
  const state = fight(5, 3);
  assert.throws(() => endTurn(state));
  assert.throws(() => attack(state, 'A1', 'B1'));
});

test('Offensive points: +1 strength each on an attack, or 2 points buy an extra attack', () => {
  assert.equal(fight(3, 3, 'offensive').pending, null); // +0: a tie
  const armed = play(duel(3, 3), 'offensive'); // A: level 3 = 3 points
  assert.equal(maxBonus(armed), 3);
  assert.throws(() => attack(armed, 'A1', 'B1', 4));
  const strong = attack(armed, 'A1', 'B1', 1);
  assert.equal(strong.pending.winnerId, 'A1');
  assert.equal(strong.active.points, 2);
  assert.equal(attack(armed, 'A1', 'B1', 3).active, null, 'spending the pool ends the order');
});

test('an extra attack costs points, leaving less for bonuses; a different stack must make it', () => {
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
  let s = attack(play(state, 'offensive'), 'A1', 'B1', 1); // 3 points: 1 spent, 2 left; B1 loses 1 + 1 and is destroyed
  assert.equal(s.pending, null);
  assert.equal(maxBonus(s), 0); // the extra attack uses the remaining 2
  assert.throws(() => attack(s, 'A2', 'B2', 1));
  assert.deepEqual(legalAttacks(s, 'A1'), []);
  assert.ok(eligibleStacks(s).every((st) => st.id !== 'A1'));
  s = attack(s, 'A2', 'B2');
  assert.equal(s.active, null);

  // Bonus 2 leaves 1 point, which cannot pay for another attack.
  assert.equal(attack(play(state, 'offensive'), 'A1', 'B1', 2).active, null);
});

test('Fortify spends points on trench chips up to the doctrine limit per hex', () => {
  let state = endTurn(duel(3, 3)); // Player B: 3 defensive cards = 3 points, limit 3
  state = applyToStack(play(state, 'fortify'), 'B1');
  assert.equal(state.defense['2,2'], 1);
  assert.equal(state.active.points, 2);
  state = applyToStack(applyToStack(state, 'B1'), 'B1');
  assert.equal(state.defense['2,2'], 3, 'all points can be piled on one hex');
  assert.equal(state.active, null, 'the order ends when the points are spent');
  state.played = 0;
  const full = give(state, 'fortify');
  assert.match(cardIssue(full, full.hands.B.at(-1)), /No stack/);
  const lowLevel = give(setDoctrine(duel(3, 3), 'A', { defensive: 0 }), 'fortify'); // limit 1
  lowLevel.defense['1,2'] = 1;
  assert.match(cardIssue(lowLevel, lowLevel.hands.A.at(-1)), /No stack/);
});

test('Hold braces a stack until its owner next turn; moving removes the bracing', () => {
  let state = applyToStack(play(duel(3, 3), 'hold'), 'A1');
  assert.equal(state.stacks[0].braced, 1);
  state = endTurn(state);
  assert.equal(state.stacks[0].braced, 1);
  state = endTurn(state);
  assert.equal(state.stacks[0].braced, 0);
  const braced = applyToStack(play(duel(3, 3), 'hold'), 'A1');
  const moved = moveStack(braced, 'A1', 0, 2);
  assert.equal(moved.stacks[0].braced, 0);
});

test('Logistics: merge and split cost 1 point each, rally 2; level sets the pool', () => {
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
  assert.equal(play(base, 'logistics').active.points, 2); // A: 2 reorganizational cards
  assert.equal(play(setDoctrine(base, 'A', { reorganizational: 0 }), 'logistics').active.points, 1);

  const armedMerge = chooseMode(play(base, 'logistics'), 'merge');
  assert.deepEqual(legalMerges(armedMerge, 'A1').map((s) => s.id), ['A2']);
  const merged = mergeStacks(armedMerge, 'A2', 'A1');
  assert.equal(merged.stacks.find((s) => s.id === 'A1').men, 7);
  assert.equal(merged.stacks.filter((s) => s.owner === 'A').length, 1);
  assert.equal(merged.active.points, 1, 'the rest of the pool is still usable');

  const armed = chooseMode(play(base, 'logistics'), 'split');
  const [hex] = legalSplits(armed, 'A1');
  const split = splitStack(armed, 'A1', hex.col, hex.row);
  assert.equal(split.stacks.find((s) => s.id === 'A1').men, 3);
  assert.equal(stackAt(split, hex.col, hex.row).men, 2);
  assert.equal(stackAt(split, hex.col, hex.row).id, 'A3');
  assert.equal(stackAt(split, hex.col, hex.row).gear, 0);
  assert.deepEqual(legalMoves(split, 'A3'), [], 'the new stack used its step arriving');

  // At level 3 a split can take one gear chip along.
  const geared = setDoctrine(base, 'A', { reorganizational: 3 });
  geared.stacks[0].gear = 2;
  const sent = splitStack(chooseMode(play(geared, 'logistics'), 'split'), 'A1', hex.col, hex.row);
  assert.equal(stackAt(sent, hex.col, hex.row).gear, 1);
  assert.equal(sent.stacks.find((s) => s.id === 'A1').gear, 1);

  const rallied = applyToStack(chooseMode(play(base, 'logistics'), 'rally'), 'A1');
  assert.equal(rallied.stacks[0].gear, 1);
  assert.equal(rallied.active, null, 'rally costs the whole 2-point pool');
  assert.throws(() => chooseMode(play(setDoctrine(base, 'A', { reorganizational: 0 }), 'logistics'), 'rally'));
});

test('Home Front: propaganda, relief and recruits; Posture scales with doctrine', () => {
  let state = endTurn(duel(3, 3)); // Player B: willingness 2 = 3 points
  state.weariness.B = 1;
  const before = state.resolve.B;
  let front = applyPool(play(state, 'homefront'), 'propaganda');
  assert.equal(front.resolve.B, before + 1);
  assert.equal(front.active.points, 2);
  front = applyPool(front, 'relief');
  assert.equal(front.weariness.B, 0, 'relief cannot go below zero');
  assert.equal(front.active.points, 1);
  assert.throws(() => chooseMode(front, 'recruit'), /Not enough/);
  const recruit = applyToStack(chooseMode(play(state, 'homefront'), 'recruit'), 'B1');
  assert.equal(recruit.stacks.find((s) => s.id === 'B1').men, 4);
  assert.equal(recruit.active.points, 1);
  const away = duel(3, 3);
  away.stacks[0].col = 3; // A1 on B's side of the border
  assert.deepEqual(eligibleStacks(chooseMode(play(away, 'homefront'), 'recruit')), [], 'no recruits on enemy ground');
  assert.equal(play(setDoctrine(state, 'B', { willingness: 0 }), 'homefront').active.points, 2);

  const posture = play(state, 'posture');
  assert.ok(posture.stacks.filter((s) => s.owner === 'B').every((s) => s.braced === 3));
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
  state.thresholds = { A: 999, B: 999 }; // weariness grows every turn; keep the surrender cards harmless
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

test('bloodletting: the attacker pays for terrain and trenches, the defender for offensive points', () => {
  assert.equal(fight(6, 3, 'attack', { '2,2': 'fortified' }).stacks[0].men, 4); // paid 2
  const dug = play(duel(9, 3, { '2,2': 'rough' }), 'attack');
  dug.defense['2,2'] = 2;
  assert.equal(attack(dug, 'A1', 'B1').stacks[0].men, 6); // rough + 2 trenches: paid 3
  const shelled = attack(play(duel(9, 5), 'offensive'), 'A1', 'B1', 2);
  assert.equal(shelled.stacks.find((s) => s.id === 'B1').men, 2); // 1 + 2 offensive points
});

// A duel where B has a second stack far away, so destroying B1 does not end the game.
function duelWithReserve(a, b) {
  const state = duel(a, b);
  state.stacks.push({ id: 'B9', owner: 'B', col: 6, row: 0, men: 3, gear: 0, braced: 0, spent: false });
  return state;
}

test('an advancing stack is spent until its owner next turn begins', () => {
  let state = attack(play(duelWithReserve(6, 1), 'attack'), 'A1', 'B1'); // B1 dies, A1 advances
  const attacker = state.stacks.find((s) => s.id === 'A1');
  assert.equal(attacker.spent, true);
  assert.equal(strength(state, attacker, false), attacker.men + attacker.gear - 1);
  state = endTurn(state); // B's turn: A1 is still spent
  assert.equal(state.stacks.find((s) => s.id === 'A1').spent, true);
  state = endTurn(state);
  assert.equal(state.stacks.find((s) => s.id === 'A1').spent, false);
});

test('war weariness grows on turns without a capture and resets when ground is taken', () => {
  let state = duel(3, 3);
  state.resolve.A = 0;
  state = endTurn(state);
  assert.equal(state.weariness.A, 1);
  assert.equal(breakScore(state, 'A'), 1);
  state = endTurn(endTurn(state));
  assert.equal(state.weariness.A, 2);
});

test('capturing a hex resets war weariness', () => {
  let state = duelWithReserve(6, 1);
  state.weariness.A = 5;
  state = attack(play(state, 'attack'), 'A1', 'B1');
  state = endTurn(state);
  assert.equal(state.weariness.A, 0);
});

test('holding the enemy capital through the enemy turn wins the war outright', () => {
  let state = duel(3, 3);
  const capital = state.capitals.B;
  state.stacks.find((s) => s.id === 'A1').col = capital.col;
  state.stacks.find((s) => s.id === 'A1').row = capital.row;
  state = endTurn(state);
  assert.equal(state.over, null);
  assert.equal(state.siege.A, 'armed');
  state = endTurn(state);
  assert.equal(state.over.winner, 'A');
  assert.match(state.over.reason, /capital/);
});

test('an enemy driven off the capital before the round ends does not win', () => {
  let state = duel(3, 3);
  const a1 = state.stacks.find((s) => s.id === 'A1');
  [a1.col, a1.row] = [state.capitals.B.col, state.capitals.B.row];
  state = endTurn(state);
  state.stacks = state.stacks.filter((s) => s.id !== 'A1');
  state.stacks.push({ id: 'A9', owner: 'A', col: 1, row: 2, men: 3, gear: 0, braced: 0, spent: false });
  state = endTurn(state);
  assert.equal(state.over, null);
  assert.equal(state.siege.A, null);
});

test('the map starts with trench chips on the front and second lines', () => {
  const state = createGame(map, config);
  assert.equal(state.defense['5,0'], 1);
  assert.equal(state.defense['0,3'], 2);
});

test('the starting front is sealed: neither side can walk past the other without assaulting', () => {
  const state = createGame(map, config);
  for (let row = 0; row < state.rows; row++) {
    assert.ok(inEnemyZoc(state, 'B', 4, row), `A's zone covers (4,${row})`);
    assert.ok(inEnemyZoc(state, 'A', 7, row), `B's zone covers (7,${row})`);
  }
  for (const stack of state.stacks) {
    for (const hex of legalMoves({ ...state, current: stack.owner }, stack.id)) {
      assert.ok(!inEnemyZoc(state, stack.owner, hex.col, hex.row));
    }
  }
});

test('an assault steps into the enemy zone first; unprepared it is hasty (-2 strength)', () => {
  const armed = play(gapDuel(5, 3), 'attack');
  assert.deepEqual(legalAttacks(armed, 'A1'), [], 'nothing is adjacent');
  const [entry] = legalAssaults(armed, 'A1');
  assert.deepEqual([entry.col, entry.row, entry.targets[0].id], [2, 2, 'B1']);
  const hasty = assault(5, 3); // 5 - 2 = 3 against 3: a tie
  assert.equal(hasty.pending, null);
  const a1 = hasty.stacks.find((s) => s.id === 'A1');
  assert.deepEqual([a1.col, a1.men, a1.fought], [2, 4, true], 'the assaulter now stands in the zone');
  assert.ok(hasty.log.some((l) => l.includes('hasty -2')));
  assert.equal(assault(6, 3).pending.winnerId, 'A1');
  assert.equal(attack(play(gapDuel(3, 3), 'attack'), 'A1', 'B1', 0, ENTRY).stacks[0].men, 2);
  assert.throws(() => attack(armed, 'A1', 'B1'), /Illegal/, 'no direct attack across a gap');
  assert.throws(() => attack(armed, 'A1', 'B1', 0, { col: 0, row: 2 }), /Illegal/);
});

test('Offensive points can pay 2 to enter the zone cleanly, leaving the rest as bonus', () => {
  const armed = play(gapDuel(3, 3), 'offensive'); // 3 points
  assert.equal(maxBonus(armed, true), 1);
  assert.throws(() => attack(armed, 'A1', 'B1', 2, ENTRY, true), /affordable/);
  const paid = attack(armed, 'A1', 'B1', 1, ENTRY, true); // 3 + 1 against 3
  assert.equal(paid.pending.winnerId, 'A1');
  assert.equal(paid.active, null, 'the pool is spent');
  assert.throws(() => attack(play(gapDuel(3, 3), 'attack'), 'A1', 'B1', 0, ENTRY, true), /affordable/);
});

test('a stack that already moved or fought cannot assault; contact attacks stay free', () => {
  const moved = play(gapDuel(5, 3), 'attack');
  moved.stacks[0].moved = 1;
  assert.deepEqual(legalAssaults(moved, 'A1'), []);
  const contact = play(duel(5, 3), 'attack');
  contact.stacks[0].moved = 1;
  assert.equal(legalAttacks(contact, 'A1').length, 1, 'a stack in contact can still attack');
  const fought = resolveHold(attack(play(duelWithReserve(5, 3), 'attack'), 'A1', 'B1'));
  assert.equal(fought.stacks.find((s) => s.id === 'A1').fought, true);
  assert.deepEqual(legalMoves(fought, 'A1'), [], 'a stack that fought cannot step');
});

test('Counter-attack only hits a spent enemy, and entering its zone is free', () => {
  let state = give(setDoctrine(gapDuel(3, 3), 'A', { defensive: 3 }), 'counter');
  assert.match(cardIssue(state, state.hands.A.at(-1)), /No stack/);
  state.stacks[1].spent = true; // B1 just advanced: 3 - 1 = 2 defense
  assert.equal(cardIssue(state, state.hands.A.at(-1)), null);
  state = playCard(state, state.hands.A.at(-1).uid);
  assert.equal(state.active.points, 2);
  const won = attack(state, 'A1', 'B1', 0, ENTRY); // no hasty penalty: 3 against 2
  assert.equal(won.pending.winnerId, 'A1');
  assert.equal(maxBonus(state), 2);
});

test('Elastic Defence makes retreats free until its owner next turn, even for a stack with no chip to spare', () => {
  let state = endTurn(duel(5, 2));
  state = endTurn(play(state, 'elastic'));
  assert.equal(state.elastic.B, true);
  state = attack(play(state, 'attack'), 'A1', 'B1'); // B1 is down to 1 man
  const [hex] = retreatOptions(state);
  assert.ok(hex, 'a lone man may retreat');
  state = resolveRetreat(state, hex.col, hex.row);
  assert.equal(state.stacks.find((s) => s.id === 'B1').men, 1, 'no retreat cost');
  assert.match(state.log.at(-2), /elastic/);
  assert.equal(endTurn(endTurn(state)).elastic.B, false);
});

test('a nation with no stacks left surrenders at once', () => {
  let state = duel(3, 1);
  state = attack(play(state, 'attack'), 'A1', 'B1'); // attrition destroys the lone man
  assert.equal(state.over.loser, 'B');
  assert.match(state.over.reason, /destroyed/);
});
