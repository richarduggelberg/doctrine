import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyPool, applyToStack, attack, breakScore, cardIssue, chooseMode, countryAt, createGame, discardCard, eligibleStacks, endOrder,
  endTurn, featuresAt, fortification, inBounds, inEnemyZoc, legalAttacks, legalMerges, legalMoves, legalSplits,
  maxBonus, mergeStacks, moveStack, orderTier, pairIssue, playCard, resolveHold, resolveRetreat, retreatOptions, splitStack,
  stackAt, strength, terrainAt, terrainBonus, territoryOf,
} from '../js/engine.js';
import { distance, neighbors } from '../js/hex.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const map = read('../data/map.json');
const config = read('../data/cards.json');

// Put a specific card (suit letter S/C/D/H, rank 2-14) in the current player's hand; hands are otherwise random.
function give(state, suit, rank) {
  const next = structuredClone(state);
  const hand = next.hands[next.current];
  hand.push({ uid: `test-${suit}${rank}-${hand.length}`, suit: config.suits[suit], rank });
  return next;
}

function play(state, suit, rank) {
  const given = give(state, suit, rank);
  return playCard(given, given.hands[given.current].at(-1).uid);
}

function playPair(state, suit, first, second) {
  const given = give(give(state, suit, first), suit, second);
  const hand = given.hands[given.current];
  return playCard(given, hand.at(-2).uid, hand.at(-1).uid);
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

// Player A's weakest Offensive: a 2 under a level 1 doctrine is tier 0, an attack with no bonus points.
const bare = (state) => play(setDoctrine(state, 'A', { aggressive: 1 }), 'S', 2);
const fight = (a, b, terrain = {}) => attack(bare(duel(a, b, terrain)), 'A1', 'B1');

// A duel with an empty hex between the stacks: B1 at (4,2).
function gapDuel(a, b) {
  const state = duel(a, b);
  state.stacks[1].col = 4;
  return state;
}

// A duel where B has a second stack far away, so destroying B1 does not end the game.
function duelWithReserve(a, b) {
  const state = duel(a, b);
  state.stacks.push({ id: 'B9', owner: 'B', col: 6, row: 0, men: 3, gear: 0, braced: 0, spent: false });
  return state;
}

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

test('setup: 1914 armies, 5-card hands, and a seeded 52-card deck per player without jokers', () => {
  const state = createGame(map, config, 42);
  const count = (owner) => state.stacks.filter((s) => s.owner === owner).length;
  assert.ok(count('A') >= 4 && count('B') >= 4);
  assert.equal(new Set(state.stacks.map((s) => `${s.col},${s.row}`)).size, state.stacks.length);
  for (const s of state.stacks) assert.ok(inBounds(state, s.col, s.row));
  for (const p of ['A', 'B']) {
    assert.equal(state.hands[p].length, 5);
    const cards = [...state.decks[p], ...state.hands[p]];
    assert.equal(cards.length, 52);
    assert.equal(new Set(cards.map((c) => c.uid)).size, 52);
    for (const suit of Object.values(config.suits)) {
      assert.deepEqual(cards.filter((c) => c.suit === suit).map((c) => c.rank).sort((x, y) => x - y),
        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    }
    assert.ok(state.thresholds[p] >= config.surrender.thresholdMin);
  }
  assert.deepEqual(createGame(map, config, 42).hands, state.hands);
  assert.notDeepEqual(createGame(map, config, 43).hands, state.hands);
});

test('armies start in their own territory on the front line, out of contact', () => {
  const state = createGame(map, config, 1);
  for (const s of state.stacks) {
    assert.equal(territoryOf(state, s.col, s.row), s.owner);
    assert.ok(inBounds(state, s.col, s.row), `${s.id} is on land`);
    assert.ok(s.men >= 3 && s.men <= 5);
  }
  const gap = Math.min(
    ...state.stacks.filter((s) => s.owner === 'A').flatMap((a) =>
      state.stacks.filter((s) => s.owner === 'B').map((b) => distance(a, b))),
  );
  assert.ok(gap >= 2, 'no stacks adjacent at the start');
  assert.equal(territoryOf(state, state.capitals.A.col, state.capitals.A.row), 'A');
  assert.equal(territoryOf(state, state.capitals.B.col, state.capitals.B.row), 'B');
});

test('attacking needs an Offensive card, but moving does not', () => {
  const state = duel(3, 3);
  assert.deepEqual(legalAttacks(state, 'A1'), []);
  assert.ok(legalMoves(state, 'A1').length > 0);
});

test('rank bands and the doctrine shift set the tier; doctrine can lift a card above its band', () => {
  const state = duel(3, 3);
  const tiers = (owner, suit) => [2, 4, 5, 7, 8, 10, 11, 13, 14].map((r) => orderTier(state, owner, suit, [r]));
  // A has 3 aggressive cards (+1), 2 reorganizational (0), 1 defensive (-1) and no willingness (-2).
  assert.deepEqual(tiers('A', 'aggressive'), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
  assert.deepEqual(tiers('A', 'reorganizational'), [0, 0, 1, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual(tiers('A', 'defensive'), [0, 0, 0, 0, 1, 1, 2, 2, 3]);
  assert.deepEqual(tiers('B', 'aggressive'), [0, 0, 0, 0, 0, 0, 1, 1, 2], 'no doctrine: tiers are clamped at 0');
  assert.equal(play(state, 'S', 9).active.points, 4); // an 8-10 under level 3 plays as a face card (tier 3)
  assert.equal(play(state, 'S', 3).active.points, 2);
  assert.equal(play(endTurn(state), 'S', 9).active.points, 0);
  assert.equal(play(setDoctrine(state, 'A', { aggressive: 9 }), 'S', 9).active.points, 4, 'level is capped');
});

test('two same-suit number cards played as a pair are worth their sum, plus a tier, and use both plays', () => {
  const state = duel(3, 3);
  assert.equal(orderTier(state, 'A', 'aggressive', [2, 3]), 3);
  assert.equal(orderTier(state, 'A', 'aggressive', [9, 10]), 5);
  const pair = playPair(state, 'S', 2, 3);
  assert.equal(pair.active.points, 4, 'a 2 and a 3 beat either card alone (2 points)');
  assert.equal(pair.played, 2);
  const mixed = give(give(state, 'S', 2), 'C', 3);
  const hand = mixed.hands.A;
  assert.match(pairIssue(mixed, hand.at(-2), hand.at(-1)), /same suit/);
  assert.throws(() => playCard(mixed, hand.at(-2).uid, hand.at(-1).uid));
  const faces = give(give(state, 'S', 11), 'S', 4);
  assert.match(pairIssue(faces, faces.hands.A.at(-2), faces.hands.A.at(-1)), /cannot be paired/);
  const used = give(give(state, 'S', 2), 'S', 3);
  used.played = 1;
  assert.match(pairIssue(used, used.hands.A.at(-2), used.hands.A.at(-1)), /plays left/);
});

test('face cards add abilities: Offensive Surprise, No quarter and Breakthrough', () => {
  // Surprise: trench chips do not count for the defender.
  const dug = duel(5, 3);
  dug.defense['2,2'] = 2;
  assert.equal(attack(bare(dug), 'A1', 'B1').pending, null, '5 against 3 + 2 trenches is a tie');
  assert.equal(attack(play(dug, 'S', 11), 'A1', 'B1').pending.winnerId, 'A1');
  // No quarter: a beaten defender cannot retreat.
  assert.ok(retreatOptions(attack(play(duel(5, 3), 'S', 5), 'A1', 'B1')).length > 0);
  const noQuarter = attack(play(duel(5, 3), 'S', 13), 'A1', 'B1');
  assert.equal(noQuarter.pending.winnerId, 'A1');
  assert.deepEqual(retreatOptions(noQuarter), []);
  // Breakthrough: the loser loses a man more, and the winning stack is not spent.
  const advance = (card) => {
    const won = attack(play(duelWithReserve(6, 4), 'S', card), 'A1', 'B1');
    const [hex] = retreatOptions(won);
    return resolveRetreat(won, hex.col, hex.row);
  };
  const normal = advance(5);
  assert.equal(normal.stacks.find((s) => s.id === 'A1').spent, true);
  assert.equal(normal.stacks.find((s) => s.id === 'B1').men, 2);
  const through = advance(14);
  assert.equal(through.stacks.find((s) => s.id === 'A1').spent, false);
  assert.equal(through.stacks.find((s) => s.id === 'B1').men, 1);
  // Combined arms: extra attacks cost 1 point.
  assert.equal(play(duel(3, 3), 'S', 12).active.extraCost, 1);
});

test('face cards add abilities for the other suits', () => {
  const b = endTurn(duel(3, 3)); // Player B: 3 defensive (+1), 2 willingness (0), 1 reorganizational (-1)
  assert.equal(play(b, 'C', 11).elastic.B, true, 'Elastic defence at once');
  assert.ok(play(b, 'C', 12).stacks.filter((s) => s.owner === 'B').every((s) => s.braced === 1), 'Reserves');
  assert.equal(applyToStack(chooseMode(play(b, 'C', 13), 'brace'), 'B1').stacks[1].braced, 2, 'Iron wall braces by 2');
  assert.equal(applyToStack(chooseMode(play(duel(3, 3), 'D', 11), 'rail'), 'A1').stacks[0].rail, 3, 'Rail net');
  assert.equal(play(duel(3, 3), 'D', 12).active.points, 5, 'Staff work: 3 points + 2');
  const wearied = structuredClone(b);
  wearied.weariness.B = 6;
  assert.equal(applyPool(play(wearied, 'H', 12), 'relief').weariness.B, 2, 'Relief effort removes 4');
  assert.equal(applyPool(play(b, 'H', 11), 'propaganda').resolve.B, b.resolve.B + 2, 'Propaganda drive');
  assert.equal(chooseMode(play(b, 'H', 13), 'recruit').active.menu.recruit, 1, 'Conscription');
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

test('an Offensive card needs a stack that can attack an adjacent enemy', () => {
  const lone = give(duel(1, 1), 'S', 5);
  assert.match(cardIssue(lone, lone.hands.A.at(-1)), /No stack/);
  const apart = give(gapDuel(3, 3), 'S', 5);
  assert.match(cardIssue(apart, apart.hands.A.at(-1)), /No stack/);
  const ready = give(duel(3, 3), 'S', 5);
  assert.equal(cardIssue(ready, ready.hands.A.at(-1)), null);
});

test('a stack walks 2 hexes per turn; entering an enemy zone is free but ends the walk', () => {
  let state = gapDuel(3, 3); // A1 (1,2), B1 (4,2)
  const open = (s) => legalMoves(s, 'A1').map((h) => `${h.col},${h.row}`);
  assert.ok(open(state).includes('2,2'));
  state = moveStack(state, 'A1', 2, 2);
  assert.ok(open(state).includes('3,2'), 'the hex next to the enemy is enterable');
  state = moveStack(state, 'A1', 3, 2);
  assert.equal(state.stacks[0].halted, true);
  assert.deepEqual(legalMoves(state, 'A1'), [], 'halted in the zone');
  assert.equal(state.played, 0, 'moving costs no card');
  state = endTurn(endTurn(state));
  assert.equal(state.stacks[0].halted, false);
  assert.ok(legalMoves(state, 'A1').length > 0, 'a new turn, a new walk');
});

test('a stack inside an enemy zone can only step out of it; the walk is still 2 hexes', () => {
  let state = duel(3, 3); // A1 (1,2) touches B1 (2,2)
  const open = legalMoves(state, 'A1').map((h) => `${h.col},${h.row}`);
  assert.ok(open.includes('0,2'));
  assert.ok(!open.includes('1,1') && !open.includes('1,3'), 'hexes next to the enemy are in its zone');
  state = moveStack(state, 'A1', 0, 2);
  assert.ok(legalMoves(state, 'A1').length > 0, 'a second hex');
  const [second] = legalMoves(state, 'A1');
  state = moveStack(state, 'A1', second.col, second.row);
  assert.deepEqual(legalMoves(state, 'A1'), []);
  assert.throws(() => moveStack(state, 'A1', 0, 1));
  assert.equal(legalMoves(moveStack(duel(3, 3), 'A1', 0, 2), 'B1').length, 0, 'only the current player moves');
});

test('Rail adds hexes to a stack\'s walk', () => {
  let state = applyToStack(chooseMode(play(duel(3, 3), 'D', 2), 'rail'), 'A1');
  assert.equal(state.stacks[0].rail, 2);
  const farFrom = (h) => distance(h, { col: 2, row: 2 });
  for (let i = 0; i < 4; i++) {
    const [hex] = legalMoves(state, 'A1').sort((a, b) => farFrom(b) - farFrom(a));
    state = moveStack(state, 'A1', hex.col, hex.row);
  }
  assert.deepEqual(legalMoves(state, 'A1'), [], '2 hexes of walking + 2 of rail');
});

test('only two cards can be played per turn', () => {
  const state = give(duel(3, 3), 'S', 5);
  state.played = 2;
  assert.match(cardIssue(state, state.hands.A.at(-1)), /plays left/);
});

test('cancelling an unused order refunds the card and the play', () => {
  const armed = play(duel(3, 3), 'S', 5);
  assert.equal(armed.played, 1);
  const cancelled = endOrder(armed);
  assert.equal(cancelled.played, 0);
  assert.equal(cancelled.active, null);
  assert.ok(cancelled.hands.A.some((c) => c.rank === 5 && c.suit === 'aggressive'));
});

test('terrain, trenches and bracing add to defense; a tie is a stalemate with attrition only', () => {
  const tie = fight(3, 3);
  assert.equal(tie.pending, null);
  assert.deepEqual(tie.stacks.map((s) => [s.men, s.col]), [[2, 1], [2, 2]]);
  assert.deepEqual(tie.battlesLost, { A: 0, B: 0 });
  assert.equal(tie.casualties.A + tie.casualties.B, 2);
  const rough = duel(4, 3, { '2,2': 'rough' });
  assert.equal(strength(rough, rough.stacks[1], true), 4);
  assert.equal(attack(bare(rough), 'A1', 'B1').pending, null);
  const braced = structuredClone(duel(4, 3));
  braced.stacks[1].braced = 1;
  braced.defense['2,2'] = 2;
  assert.equal(strength(braced, braced.stacks[1], true), 6);
});

test('a repulsed attacker pays only attrition; the defender gains no gear and nobody has to choose', () => {
  const state = fight(3, 5);
  assert.equal(state.pending, null);
  assert.equal(state.stacks.find((s) => s.id === 'A1').men, 2);
  const defender = state.stacks.find((s) => s.id === 'B1');
  assert.deepEqual([defender.men, defender.gear, defender.col], [4, 0, 2]);
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
  const geared = bare(duel(5, 3));
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

test('a stack that fought cannot walk any more, and one in contact can still attack', () => {
  const fought = resolveHold(attack(bare(duelWithReserve(5, 3)), 'A1', 'B1'));
  assert.equal(fought.stacks.find((s) => s.id === 'A1').fought, true);
  assert.deepEqual(legalMoves(fought, 'A1'), []);
});

test('Offensive points: +1 strength each on an attack, or 2 points buy an extra attack', () => {
  assert.equal(maxBonus(bare(duel(3, 3))), 0);
  const armed = play(duel(3, 3), 'S', 6); // tier 2 under level 3: 3 points
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
  let s = attack(play(state, 'S', 6), 'A1', 'B1', 1); // 3 points: 1 spent, 2 left; B1 loses 1 + 1 and is destroyed
  assert.equal(s.pending, null);
  assert.equal(maxBonus(s), 0); // the extra attack uses the remaining 2
  assert.throws(() => attack(s, 'A2', 'B2', 1));
  assert.deepEqual(legalAttacks(s, 'A1'), []);
  assert.ok(eligibleStacks(s).every((st) => st.id !== 'A1'));
  s = attack(s, 'A2', 'B2');
  assert.equal(s.active, null);

  // Bonus 2 leaves 1 point, which cannot pay for another attack.
  assert.equal(attack(play(state, 'S', 6), 'A1', 'B1', 2).active, null);
});

test('Defence spends points on trench chips up to the doctrine limit per hex, or on bracing', () => {
  let state = endTurn(duel(3, 3)); // Player B: 3 defensive cards: an 8 is tier 3 = 3 points, limit 3
  state = applyToStack(chooseMode(play(state, 'C', 8), 'trench'), 'B1');
  assert.equal(state.defense['2,2'], 1);
  assert.equal(state.active.points, 2);
  const full = applyToStack(applyToStack(state, 'B1'), 'B1');
  assert.equal(full.defense['2,2'], 3, 'all points can be piled on one hex');
  assert.equal(full.active, null, 'the order ends when the points are spent');
  full.played = 0;
  assert.deepEqual(eligibleStacks(chooseMode(play(full, 'C', 8), 'trench')), [], 'the hex is at the limit');
  const lowLevel = chooseMode(play(setDoctrine(duel(3, 3), 'A', { defensive: 0 }), 'C', 2), 'trench'); // limit 1
  lowLevel.defense['1,2'] = 1;
  assert.deepEqual(eligibleStacks(lowLevel), []);
});

test('Bracing lasts until its owner next turn; moving removes it', () => {
  let state = applyToStack(chooseMode(play(duel(3, 3), 'C', 2), 'brace'), 'A1');
  assert.equal(state.stacks[0].braced, 1);
  state = endTurn(state);
  assert.equal(state.stacks[0].braced, 1);
  state = endTurn(state);
  assert.equal(state.stacks[0].braced, 0);
  const braced = applyToStack(chooseMode(play(duel(3, 3), 'C', 2), 'brace'), 'A1');
  assert.equal(moveStack(braced, 'A1', 0, 2).stacks[0].braced, 0);
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
  assert.equal(play(base, 'D', 5).active.points, 2); // A: 2 reorganizational cards, a 5 is tier 1
  assert.equal(play(setDoctrine(base, 'A', { reorganizational: 0 }), 'D', 5).active.points, 1);

  const armedMerge = chooseMode(play(base, 'D', 5), 'merge');
  assert.deepEqual(legalMerges(armedMerge, 'A1').map((s) => s.id), ['A2']);
  const merged = mergeStacks(armedMerge, 'A2', 'A1');
  assert.equal(merged.stacks.find((s) => s.id === 'A1').men, 7);
  assert.equal(merged.stacks.filter((s) => s.owner === 'A').length, 1);
  assert.equal(merged.active.points, 1, 'the rest of the pool is still usable');

  const armed = chooseMode(play(base, 'D', 5), 'split');
  const [hex] = legalSplits(armed, 'A1');
  const split = splitStack(armed, 'A1', hex.col, hex.row);
  assert.equal(split.stacks.find((s) => s.id === 'A1').men, 3);
  assert.equal(stackAt(split, hex.col, hex.row).men, 2);
  assert.equal(stackAt(split, hex.col, hex.row).id, 'A3');
  assert.equal(stackAt(split, hex.col, hex.row).gear, 0);
  assert.deepEqual(legalMoves(split, 'A3'), [], 'the new stack used its walk arriving');

  // At a high tier a split can take one gear chip along.
  const geared = setDoctrine(base, 'A', { reorganizational: 3 });
  geared.stacks[0].gear = 2;
  const sent = splitStack(chooseMode(play(geared, 'D', 8), 'split'), 'A1', hex.col, hex.row);
  assert.equal(stackAt(sent, hex.col, hex.row).gear, 1);
  assert.equal(sent.stacks.find((s) => s.id === 'A1').gear, 1);

  const rallied = applyToStack(chooseMode(play(base, 'D', 5), 'rally'), 'A1');
  assert.equal(rallied.stacks[0].gear, 1);
  assert.equal(rallied.active, null, 'rally costs the whole 2-point pool');
  assert.throws(() => chooseMode(play(setDoctrine(base, 'A', { reorganizational: 0 }), 'D', 5), 'rally'));
});

test('Home Front: propaganda, relief and recruits scale with doctrine', () => {
  const state = endTurn(duel(3, 3)); // Player B: willingness 2 = tier 1 for a 5 = 3 points
  state.weariness.B = 1;
  const before = state.resolve.B;
  let front = applyPool(play(state, 'H', 5), 'propaganda');
  assert.equal(front.resolve.B, before + 1);
  assert.equal(front.active.points, 2);
  front = applyPool(front, 'relief');
  assert.equal(front.weariness.B, 0, 'relief cannot go below zero');
  assert.equal(front.active.points, 1);
  assert.throws(() => chooseMode(front, 'recruit'), /Not enough/);
  const recruit = applyToStack(chooseMode(play(state, 'H', 5), 'recruit'), 'B1');
  assert.equal(recruit.stacks.find((s) => s.id === 'B1').men, 4);
  assert.equal(recruit.active.points, 1);
  const away = duel(3, 3);
  away.stacks[0].col = 3; // A1 on B's side of the border
  assert.deepEqual(eligibleStacks(chooseMode(play(away, 'H', 5), 'recruit')), [], 'no recruits on enemy ground');
  assert.equal(play(setDoctrine(state, 'B', { willingness: 0 }), 'H', 5).active.points, 2);
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

test('each player\'s discard pile is reshuffled into their own deck when it runs out', () => {
  let state = createGame(map, config, 3);
  state.thresholds = { A: 999, B: 999 }; // weariness grows every turn; keep the surrender check harmless
  for (let i = 0; i < 200; i++) { // each player draws 1 card a turn from 47, so discards must be reshuffled
    state = discardCard(state, state.hands[state.current][0].uid);
    state = endTurn(state);
  }
  for (const p of ['A', 'B']) {
    assert.equal(state.hands[p].length, 5);
    const all = [...state.decks[p], ...state.discards[p], ...state.hands[p]];
    assert.equal(new Set(all.map((c) => c.uid)).size, 52);
    assert.ok(all.every((c) => c.uid.startsWith(`${p}:`)), 'decks never mix');
  }
});

test('break score counts casualties, lost battles and lost home ground, minus resolve', () => {
  const state = duel(3, 3);
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

test('a nation breaks at the end of its own turn once its score reaches its threshold', () => {
  let state = createGame(map, config, 5);
  state.casualties.A = 500; // A is far past any threshold, B is untouched
  state = endTurn(state);
  assert.equal(state.over.loser, 'A');
  assert.equal(state.over.winner, 'B');
  assert.match(state.over.reason, /will to fight/);
  assert.deepEqual(state.thresholds, state.over.thresholds);
  assert.throws(() => endTurn(state));
  assert.throws(() => discardCard(state, state.hands.A[0].uid));
  assert.ok(state.hands.A.every((c) => cardIssue(state, c) === 'The game is over'));
});

test('a broken nation only surrenders when its own turn ends, not the enemy\'s', () => {
  let state = createGame(map, config, 5);
  state.casualties.B = 500;
  state = endTurn(state);
  assert.equal(state.over, null);
  assert.equal(state.current, 'B');
  state = endTurn(state);
  assert.equal(state.over.loser, 'B');
});

test('bloodletting: the attacker pays for terrain and trenches, the defender for offensive points', () => {
  assert.equal(fight(6, 3, { '2,2': 'fortified' }).stacks[0].men, 4); // paid 2
  const dug = bare(duel(9, 3, { '2,2': 'rough' }));
  dug.defense['2,2'] = 2;
  assert.equal(attack(dug, 'A1', 'B1').stacks[0].men, 6); // rough + 2 trenches: paid 3
  const shelled = attack(play(duel(9, 5), 'S', 6), 'A1', 'B1', 2);
  assert.equal(shelled.stacks.find((s) => s.id === 'B1').men, 2); // 1 + 2 offensive points
});

test('an advancing stack is spent until its owner next turn begins', () => {
  let state = attack(bare(duelWithReserve(6, 1)), 'A1', 'B1'); // B1 dies, A1 advances
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
  state = attack(bare(state), 'A1', 'B1');
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

test('the map starts with trench chips on the front and deeper ones on the capitals', () => {
  const state = createGame(map, config);
  for (const s of state.stacks) assert.equal(state.defense[`${s.col},${s.row}`], 1);
  for (const cap of Object.values(state.capitals)) assert.equal(state.defense[`${cap.col},${cap.row}`], 2);
});

test('the map is the Western Front: sea along the Channel coast, Paris and Cologne as capitals', () => {
  const state = createGame(map, config);
  assert.equal(state.terrain['0,0'], 'sea');
  assert.ok(!inBounds(state, 0, 0), 'sea hexes cannot be entered');
  assert.equal(territoryOf(state, 0, 25), 'A');
  assert.equal(territoryOf(state, state.cols - 1, 25), 'B');
  assert.ok(state.capitals.B.col > state.capitals.A.col && state.capitals.B.row < state.capitals.A.row);
});

test('the five countries: France and Germany belong to the players, the rest is neutral', () => {
  const state = createGame(map, config);
  const codes = new Set(state.countries.join('').replace(/~/g, ''));
  assert.deepEqual([...codes].sort(), ['E', 'F', 'G', 'L', 'N']);
  assert.deepEqual(state.owners, { F: 'A', G: 'B' });
  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const country = countryAt(state, col, row);
      assert.equal(country === '~', terrainAt(state, col, row) === 'sea', `sea and country agree at ${col},${row}`);
      assert.equal(territoryOf(state, col, row), state.owners[country] ?? null);
    }
  }
  for (const [name, code] of [['Brussels', 'E'], ['Cologne', 'G'], ['Luxembourg', 'L'], ['Metz', 'G'], ['Paris', 'F']]) {
    const place = state.scenery.places.find((p) => p.name === name);
    assert.equal(countryAt(state, place.col, place.row), code, name);
  }
});

test('armies start as in August 1914: French and German field armies at home, none in neutral countries', () => {
  const state = createGame(map, config);
  for (const s of state.stacks) {
    assert.equal(countryAt(state, s.col, s.row), s.owner === 'A' ? 'F' : 'G');
    assert.ok(s.army, `${s.id} is a named army`);
  }
  const armies = (owner) => [...new Set(state.stacks.filter((s) => s.owner === owner).map((s) => s.army))];
  assert.equal(armies('A').length, 5, 'French 1st-5th Armies');
  assert.equal(armies('B').length, 7, 'German 1st-7th Armies');
  const soldiers = (owner) =>
    state.stacks.filter((s) => s.owner === owner).reduce((n, s) => n + s.men, 0) * state.menPerChip;
  assert.ok(soldiers('A') > 900_000 && soldiers('A') < 1_300_000, 'about a million Frenchmen');
  assert.ok(soldiers('B') > 1_200_000 && soldiers('B') < 1_700_000, 'about 1.4 million Germans');
});

test('country borders follow hex edges and rivers run through hex middles', () => {
  const state = createGame(map, config);
  for (const river of state.scenery.rivers) {
    for (let i = 1; i < river.hexes.length; i++) {
      const [a, b] = [river.hexes[i - 1], river.hexes[i]];
      assert.equal(distance({ col: a[0], row: a[1] }, { col: b[0], row: b[1] }), 1, `${river.name} is unbroken`);
    }
    for (const [col, row] of river.hexes) {
      const features = featuresAt(state, col, row);
      assert.ok(features.includes('river') || features.includes('bigriver'), `${river.name} marks ${col},${row}`);
    }
  }
});

test('terrain modifiers stack: hills + big river + city fight as 4 chips of defence', () => {
  const state = duel(3, 3, { '2,2': 'hills+bigriver+city' });
  assert.deepEqual(featuresAt(state, 2, 2), ['hills', 'bigriver', 'city']);
  assert.equal(terrainBonus(state, 2, 2), 4);
  assert.equal(fortification(state, 2, 2), 4);
  assert.equal(strength(state, state.stacks[1], true), 3 + 4, 'a defender there counts all of it');
  assert.equal(terrainBonus(state, 0, 0), 0, 'open ground adds nothing');
  const bigMap = createGame(map, config);
  const cologne = bigMap.scenery.places.find((p) => p.name === 'Cologne');
  assert.deepEqual(featuresAt(bigMap, cologne.col, cologne.row), ['bigriver', 'bigcity']);
  assert.ok(Object.values(bigMap.terrain).some((t) => t.split('+').length >= 3), 'the map has triple stacks');
});
