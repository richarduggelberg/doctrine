import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyPool, applyToStack, attack, breakScore, cardIssue, chooseMode, countryAt, createGame, discardCard, eligibleStacks, endOrder,
  endTurn, featuresAt, fortification, frontOwners, improvise, improviseIssue, inBounds, inEnemyZoc, isCutOff, legalAttacks, legalMerges, legalMoves, legalSplits,
  maxBonus, mergeStacks, moveStack, orderTier, pairIssue, playCard, resolveHold, resolveRetreat, retreatOptions, shell, shellCost,
  shellTargets, splitStack, placeRecruit, recruitSites, recruitsFor,
  stackAt, strength, support, terrainAt, terrainBonus, territoryOf, townsLost,
} from '../js/engine.js';
import { distance, neighbors } from '../js/hex.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const map = read('../data/map.json');
const config = read('../data/cards.json');
// Tests pin their own doctrines so they do not depend on the default scenario in cards.json.
config.doctrine = {
  A: { cards: { aggressive: 3, reorganizational: 2, defensive: 1, willingness: 0 } },
  B: { cards: { defensive: 3, willingness: 2, reorganizational: 1, aggressive: 0 } },
};

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
  state.stacks.push({ id: 'B9', owner: 'B', col: 6, row: 0,   men: 3, gear: 0, spent: false });
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

test('setup: 1914 armies, full hands, and a seeded 52-card deck per player without jokers', () => {
  const state = createGame(map, config, 42);
  const count = (owner) => state.stacks.filter((s) => s.owner === owner).length;
  assert.ok(count('A') >= 4 && count('B') >= 4);
  assert.equal(new Set(state.stacks.map((s) => `${s.col},${s.row}`)).size, state.stacks.length);
  for (const s of state.stacks) assert.ok(inBounds(state, s.col, s.row));
  for (const p of ['A', 'B']) {
    assert.equal(state.hands[p].length, config.startHand);
    const cards = [...state.decks[p], ...state.hands[p]];
    assert.equal(cards.length, 52);
    assert.equal(new Set(cards.map((c) => c.uid)).size, 52);
    for (const suit of Object.values(config.suits)) {
      assert.deepEqual(cards.filter((c) => c.suit === suit).map((c) => c.rank).sort((x, y) => x - y),
        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    }
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

test('two same-suit number cards played as a pair are worth their sum, plus a tier', () => {
  const state = duel(3, 3);
  assert.equal(orderTier(state, 'A', 'aggressive', [2, 3]), 3);
  assert.equal(orderTier(state, 'A', 'aggressive', [9, 10]), 5);
  const pair = playPair(state, 'S', 2, 3);
  assert.equal(pair.active.points, 4, 'a 2 and a 3 beat either card alone (2 points)');
  assert.equal(pair.played, 1, 'one order');
  const mixed = give(give(state, 'S', 2), 'C', 3);
  const hand = mixed.hands.A;
  assert.match(pairIssue(mixed, hand.at(-2), hand.at(-1)), /same suit/);
  assert.throws(() => playCard(mixed, hand.at(-2).uid, hand.at(-1).uid));
  const faces = give(give(state, 'S', 11), 'S', 4);
  assert.match(pairIssue(faces, faces.hands.A.at(-2), faces.hands.A.at(-1)), /cannot be paired/);
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
  // Breakthrough: the loser loses a man more.
  const advance = (card) => {
    const won = attack(play(duelWithReserve(6, 4),     'S', card), 'A1', 'B1');
    const [hex] = retreatOptions(won);
    return resolveRetreat(won, hex.col, hex.row);
  };
  const normal = advance(5);
  assert.equal(normal.stacks.find((s) => s.id === 'B1').men, 2);
  const through = advance(14);
  assert.equal(through.stacks.find((s) => s.id === 'B1').men, 1);
  // Combined arms: extra attacks cost 1 point.
  assert.equal(play(duel(3, 3), 'S', 12).active.extraCost, 1);
});

test('face cards add abilities for the other suits', () => {
  const b = endTurn(duel(3, 3)); // Player B: 3 defensive (+1), 2 willingness (0), 1 reorganizational (-1)
  assert.equal(play(b, 'C', 11).elastic.B, true, 'Elastic defence at once');
  assert.ok(play(b, 'C', 12).defense['2,2'] === 1, 'Reserves entrenches the stack facing the enemy');
  const wall = play(b, 'C', 13).active;
  assert.deepEqual([wall.values.points, wall.values.limit], [5, 4], 'Iron wall: +1 point, one deeper trenches');
  assert.equal(applyToStack(chooseMode(play(duel(3, 3), 'D', 11), 'rail'), 'A1').stacks[0].rail, 3, 'Rail net');
  assert.equal(play(duel(3, 3), 'D', 12).active.points, 5, 'Staff work: 3 points + 2');
  const tired = structuredClone(b);
  tired.exhaustion.B = 6;
  assert.equal(applyPool(play(tired, 'H', 12), 'relief').exhaustion.B, 3, 'Relief effort removes 3');
  assert.equal(applyPool(play(tired, 'H', 11), 'relief').exhaustion.B, 4, 'War bonds removes 2');
  assert.equal(chooseMode(play(b, 'H', 13), 'recruit').active.menu.recruit, 1, 'Conscription');
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
  const first = legalMoves(state, 'A1').filter((h) => h.dist === 1).map((h) => `${h.col},${h.row}`);
  assert.ok(first.includes('0,2'));
  assert.ok(!first.includes('1,1') && !first.includes('1,3'), 'hexes next to the enemy are in its zone');
  state = moveStack(state, 'A1', 0, 2);
  assert.ok(legalMoves(state, 'A1').length > 0, 'a second hex');
  assert.ok(legalMoves(state, 'A1').every((h) => h.dist === 1), 'one hex of the walk is left');
  const [second] = legalMoves(state, 'A1');
  state = moveStack(state, 'A1', second.col, second.row);
  assert.deepEqual(legalMoves(state, 'A1'), []);
  assert.throws(() => moveStack(state, 'A1', 0, 1));
  assert.equal(legalMoves(moveStack(duel(3, 3), 'A1', 0, 2), 'B1').length, 0, 'only the current player moves');
});

test('one move can cover the whole walk: every hex within reach is a destination', () => {
  let state = gapDuel(3, 3); // A1 (1,2), B1 (4,2)
  const reach = legalMoves(state, 'A1');
  assert.ok(reach.some((h) => h.dist === 2), 'two-hex destinations are listed');
  assert.ok(reach.every((h) => h.dist <= 2));
  const far = reach.find((h) => h.dist === 2 && !(h.col === 3 && h.row === 2));
  state = moveStack(state, 'A1', far.col, far.row);
  assert.equal(state.stacks[0].moved, 2);
  assert.deepEqual(legalMoves(state, 'A1'), [], 'the whole walk was used in one move');
  // A zone hex only ever ends a walk.
  const zoneHex = legalMoves(gapDuel(3, 3), 'A1').find((h) => h.col === 3 && h.row === 2);
  assert.equal(zoneHex?.dist, 2);
  assert.equal(moveStack(gapDuel(3, 3), 'A1', 3, 2).stacks[0].halted, true);
});

test('Rail adds hexes to a stack\'s walk', () => {
  let state = applyToStack(chooseMode(play(duel(3, 3), 'D', 2), 'rail'), 'A1');
  assert.equal(state.stacks[0].rail, 2);
  const farthest = Math.max(...legalMoves(state, 'A1').map((h) => h.dist));
  assert.equal(farthest, 4, '2 hexes of walking + 2 of rail');
  const hex = legalMoves(state, 'A1').find((h) => h.dist === 4);
  state = moveStack(state, 'A1', hex.col, hex.row);
  assert.deepEqual(legalMoves(state, 'A1'), []);
});

test('plays per turn are not capped: every card in hand can be played', () => {
  let state = duel(3, 3);
  for (let i = 0; i < 4; i++) state = give(state, 'S', 5);
  state.played = 6;
  assert.equal(cardIssue(state, state.hands.A.at(-1)), null);
});

test('cancelling an unused order refunds the card and the play', () => {
  const armed = play(duel(3, 3), 'S', 5);
  assert.equal(armed.played, 1);
  const cancelled = endOrder(armed);
  assert.equal(cancelled.played, 0);
  assert.equal(cancelled.active, null);
  assert.ok(cancelled.hands.A.some((c) => c.rank === 5 && c.suit === 'aggressive'));
});

test('terrain and trenches add to defense; a tie is a stalemate with attrition only', () => {
  const tie = fight(3, 3);
  assert.equal(tie.pending, null);
  assert.deepEqual(tie.stacks.map((s) => [s.men, s.col]), [[2, 1], [2, 2]]);
  assert.equal(tie.casualties.A + tie.casualties.B, 2);
  const rough = duel(4, 3, { '2,2': 'rough' });
  assert.equal(strength(rough, rough.stacks[1], true), 4);
  assert.equal(attack(bare(rough), 'A1', 'B1').pending, null);
  const trenched = structuredClone(duel(4, 3));
  trenched.defense['2,2'] = 2;
  assert.equal(strength(trenched, trenched.stacks[1], true), 5);
});

test('a defender is backed by adjacent friendly stacks, up to the cap, and only by friends', () => {
  const state = duel(4, 3);
  const b1 = state.stacks[1];
  assert.equal(support(state, b1), 0);
  const withNeighbours = (extra) => {
    const next = structuredClone(state);
    for (const [col, row] of extra) next.stacks.push({ id: `X${col}${row}`, owner: 'B', col, row, men: 2, gear: 0 });
    return next;
  };
  const one = withNeighbours([[3, 2]]);
  assert.equal(support(one, one.stacks[1]), config.support.perStack);
  assert.equal(strength(one, one.stacks[1], true), 3 + config.support.perStack);
  assert.equal(strength(one, one.stacks[1], false), 3, 'support does not help an attacker');
  const many = withNeighbours([[3, 2], [2, 1], [2, 3]]);
  assert.equal(support(many, many.stacks[1]), config.support.max, 'the bonus is capped');
  assert.equal(support(many, many.stacks[0]), 0, "the enemy's neighbours do not support A1");
  const far = withNeighbours([[5, 2]]);
  assert.equal(support(far, far.stacks[1]), 0, 'a stack two hexes away gives nothing');
});

test('a repulsed attacker pays only attrition; the defender gains no gear and nobody has to choose', () => {
  const state = fight(3, 5);
  assert.equal(state.pending, null);
  assert.equal(state.stacks.find((s) => s.id === 'A1').men, 2);
  const defender = state.stacks.find((s) => s.id === 'B1');
  assert.deepEqual([defender.men, defender.gear, defender.col], [4, 0, 2]);
});

test('the attacker gains gear only when it displaces the defender; the defender loses a man and may retreat', () => {
  let state = fight(5, 3);
  assert.equal(state.pending.winnerId, 'A1');
  assert.equal(state.stacks[0].men, 4);
  assert.equal(state.stacks[0].gear, 0, 'no gear until the hex is taken');
  assert.equal(state.stacks[1].men, 2); // attrition
  const options = retreatOptions(state);
  assert.ok(options.length > 0);
  for (const o of options) assert.ok(!inEnemyZoc(state, 'B', o.col, o.row), 'a retreat must leave every enemy zone');
  state = resolveRetreat(state, options[0].col, options[0].row);
  assert.equal(state.stacks.find((s) => s.id === 'B1').men, 1); // no gear: the retreat costs a man
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [2, 2]);
  assert.equal(state.stacks[0].gear, 1);
  assert.equal(state.pending, null);
  assert.equal(state.casualties.A + state.casualties.B, 3);

  // A defender that stands its ground keeps the hex, so the attacker gains nothing.
  const held = resolveHold(fight(5, 3));
  assert.equal(held.stacks.find((s) => s.id === 'A1').gear, 0);
  assert.deepEqual([held.stacks.find((s) => s.id === 'A1').col, held.stacks.find((s) => s.id === 'B1').col], [1, 2]);
});

test('experience never exceeds men: it is capped when gained and shed when men are lost', () => {
  // Attacker with 1 man left after attrition: 2 men, attrition costs 1 -> gear capped at 1 man.
  const won = fight(2, 1);
  assert.equal(won.stacks[0].men, 1);
  assert.ok(won.stacks[0].gear <= won.stacks[0].men);

  // Losing men sheds the experience that no longer fits.
  const geared = bare(duel(4, 3));
  geared.stacks[0].gear = 4;
  const after = attack(geared, 'A1', 'B1').stacks.find((s) => s.id === 'A1');
  assert.equal(after.men, 3);
  assert.equal(after.gear, 3);

  // Rally cannot lift gear above men.
  const full = duel(2, 2);
  full.stacks[0].gear = 2;
  assert.throws(() => applyToStack(chooseMode(play(full, 'D', 5), 'rally'), 'A1'));
  full.stacks[0].gear = 1;
  assert.equal(applyToStack(chooseMode(play(full, 'D', 5), 'rally'), 'A1').stacks[0].gear, 2);
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

test('Reserves gives every stack facing the enemy a free trench chip, up to the limit', () => {
  const b = endTurn(duel(3, 3));
  const far = structuredClone(b);
  far.stacks.push({ id: 'B8', owner: 'B', col: 6, row: 0, men: 2, gear: 0 });
  const reserves = play(far, 'C', 12);
  assert.equal(reserves.defense['2,2'], 1, 'B1 faces A1');
  assert.equal(reserves.defense['6,0'], undefined, 'B8 does not face anyone');
  assert.equal(reserves.active.acted, true, 'the effect is spent, so it cannot be cancelled for a refund');
  const full = structuredClone(far);
  full.defense['2,2'] = 4;
  assert.equal(play(full, 'C', 12).defense['2,2'], 4, 'the hex is at the limit');
});

test('improvising: two same-suit cards make one rank-2 order of any suit', () => {
  const given = give(give(duel(3, 3), 'C', 13), 'C', 9);
  const [k, nine] = given.hands.A.slice(-2);
  const spy = improvise(given, k.uid, nine.uid, 'aggressive');
  assert.equal(spy.played, 1, 'one play');
  assert.equal(spy.active.kind, 'attack');
  assert.equal(spy.active.points, 2, 'a rank 2 is tier 0, lifted to tier 1 by the level-3 offensive doctrine');
  assert.equal(spy.hands.A.some((c) => c.uid === k.uid || c.uid === nine.uid), false);
  assert.equal(spy.active.name, 'Offensive', 'no face ability is carried over');
  assert.equal(spy.active.suit, 'aggressive');
  const done = endOrder(spy);
  assert.equal(done.played, 0, 'cancelling refunds the play');
  assert.ok(done.hands.A.some((c) => c.uid === k.uid) && done.hands.A.some((c) => c.uid === nine.uid), 'and returns both cards');
  assert.equal(improvise(given, k.uid, nine.uid, 'defensive').played, 1, 'any suit can be chosen');
});

test('improvising follows the usual rules', () => {
  const mixed = give(give(duel(3, 3), 'C', 5), 'S', 6);
  const [x, y] = mixed.hands.A.slice(-2);
  assert.match(improviseIssue(mixed, x, y, 'aggressive'), /same suit/);
  assert.throws(() => improvise(mixed, x.uid, y.uid, 'aggressive'));
  const pair = give(give(duel(3, 3), 'C', 5), 'C', 6);
  const [p, q] = pair.hands.A.slice(-2);
  assert.match(improviseIssue(pair, p, p, 'aggressive'), /different/);
  const noTarget = structuredClone(pair);
  noTarget.stacks[0].col = 0; // out of reach of every enemy stack
  assert.match(improviseIssue(noTarget, p, q, 'aggressive'), /No stack/);
  assert.equal(improviseIssue(noTarget, p, q, 'defensive'), null);
  // The doctrine shift of the chosen suit applies: Player A's level-3 offensive lifts a rank 2 one tier.
  const strong = improvise(pair, p.uid, q.uid, 'aggressive');
  const weak = improvise(setDoctrine(pair, 'A', { aggressive: 0 }), p.uid, q.uid, 'aggressive');
  assert.equal(strong.active.points, 2);
  assert.equal(weak.active.points, 0);
});

test('the front line gives each hex to the nearer side, and none to equidistant hexes', () => {
  const state = gapDuel(3, 3); // A1 at (1,2), B1 at (4,2)
  const owners = frontOwners(state);
  assert.equal(owners['1,2'], 'A');
  assert.equal(owners['4,2'], 'B');
  assert.equal(owners['0,2'], 'A');
  assert.equal(owners['6,2'], 'B');
  for (const [hex, owner] of Object.entries(owners)) {
    const [col, row] = hex.split(',').map(Number);
    const [a, b] = [state.stacks[0], state.stacks[1]].map((s) => distance(s, { col, row }));
    assert.equal(owner, a < b ? 'A' : b < a ? 'B' : null);
  }
  assert.ok(Object.values(owners).includes(null), 'there is a no-man\'s-land');
  const alone = structuredClone(state);
  alone.stacks = alone.stacks.filter((s) => s.owner === 'A');
  assert.deepEqual(frontOwners(alone), {}, 'no front without an enemy');
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

  // Experience is split evenly too: the new stack gets the lower half.
  const geared = structuredClone(base);
  geared.stacks[0].gear = 3;
  const sent = splitStack(chooseMode(play(geared, 'D', 5), 'split'), 'A1', hex.col, hex.row);
  assert.equal(stackAt(sent, hex.col, hex.row).gear, 1);
  assert.equal(sent.stacks.find((s) => s.id === 'A1').gear, 2);

  const rallied = applyToStack(chooseMode(play(base, 'D', 5), 'rally'), 'A1');
  assert.equal(rallied.stacks[0].gear, 1);
  assert.equal(rallied.active, null, 'rally costs the whole 2-point pool');
  assert.throws(() => chooseMode(play(setDoctrine(base, 'A', { reorganizational: 0 }), 'D', 5), 'rally'));
});

test('Home Front: relief and recruits scale with doctrine', () => {
  const state = endTurn(duel(3, 3)); // Player B: willingness 2 = tier 1 for a 5 = 3 points
  state.exhaustion.B = 1;
  let front = applyPool(play(state, 'H', 5), 'relief');
  assert.equal(front.exhaustion.B, 0);
  assert.equal(front.active.points, 2);
  front = applyPool(front, 'relief');
  assert.equal(front.exhaustion.B, 0, 'relief cannot go below zero');
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

test('ending a turn draws drawPerTurn cards up to the hand cap, and switches player', () => {
  let state = createGame(map, config, 7);
  assert.equal(state.hands.A.length, config.startHand);
  state = endTurn(state);
  assert.equal(state.current, 'B');
  assert.equal(state.hands.A.length, config.startHand + config.drawPerTurn);
  assert.equal(state.played, 0);
  state = endTurn(state);
  assert.equal(state.current, 'A');
  assert.equal(state.turn, 2);
  for (let i = 0; i < 6; i++) state = endTurn(state);
  assert.equal(state.hands.A.length, config.handSize, 'the hand is capped');
});

test('discarding is unlimited and does nothing: no card comes back in its place', () => {
  let state = createGame(map, config, 7);
  const first = state.hands.A[0];
  state = discardCard(state, first.uid);
  assert.equal(state.hands.A.length, config.startHand - 1);
  assert.ok(!state.hands.A.some((c) => c.uid === first.uid));
  assert.equal(state.discards.A.at(-1).uid, first.uid);
  assert.equal(state.played, 0, 'a discard is not an order');
  state = discardCard(state, state.hands.A[0].uid);
  assert.equal(state.hands.A.length, config.startHand - 2, 'as many as you like');
  state = endTurn(state);
  assert.equal(state.hands.A.length, config.startHand - 2 + config.drawPerTurn);
});

test('each player\'s discard pile is reshuffled into their own deck when it runs out', () => {
  let state = createGame(map, config, 3);
  state.surrender.threshold = 99999; // exhaustion grows every turn; keep the surrender check harmless
  for (let i = 0; i < 200; i++) { // plenty of draws from 52 cards, so discards must be reshuffled
    state.discards[state.current].push(...state.hands[state.current].splice(0));
    state = endTurn(state);
  }
  for (const p of ['A', 'B']) {
    assert.ok(state.hands[p].length >= 1);
    const all = [...state.decks[p], ...state.discards[p], ...state.hands[p]];
    assert.equal(new Set(all.map((c) => c.uid)).size, 52);
    assert.ok(all.every((c) => c.uid.startsWith(`${p}:`)), 'decks never mix');
  }
});
test('the exhaustion meter is casualties plus accumulated ticks, and relief cannot cut casualties', () => {
  const state = duel(3, 3);
  assert.equal(breakScore(state, 'A'), 0);
  state.casualties.A = 4;
  state.exhaustion.A = 3;
  assert.equal(breakScore(state, 'A'), 7);
  assert.equal(breakScore(state, 'B'), 0);
});
test('a nation breaks at the end of its own turn once its score reaches its threshold', () => {
  let state = createGame(map, config, 5);
  state.casualties.A = 500; // A is far past the threshold, B is untouched
  state = endTurn(state);
  assert.equal(state.over.loser, 'A');
  assert.equal(state.over.winner, 'B');
  assert.match(state.over.reason, /will to fight/);
  assert.equal(state.over.threshold, config.surrender.threshold);
  assert.deepEqual(state.over.scores, { A: breakScore(state, 'A'), B: breakScore(state, 'B') });
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

test('artillery shells an adjacent stack for 1 point plus its trench chips, never below 2 men', () => {
  const sheller = (a, b, trenches = 0) => {
    const state = duel(a, b);
    if (trenches) state.defense['2,2'] = trenches;
    return play(state, 'S', 8); // tier 3 for A: 4 points
  };
  let state = sheller(5, 4);
  assert.deepEqual(shellTargets(state).map((s) => s.id), ['B1']);
  state = shell(state, 'B1');
  const [a, b] = ['A1', 'B1'].map((id) => state.stacks.find((s) => s.id === id));
  assert.deepEqual([a.men, a.fought, b.men, state.active.points, state.casualties.B], [5, false, 3, 3, 1]);
  state = shell(state, 'B1');
  assert.equal(state.stacks.find((s) => s.id === 'B1').men, 2);
  assert.deepEqual(shellTargets(state), [], 'a stack of 2 men is beyond artillery');
  assert.throws(() => shell(state, 'B1'));

  // Each trench chip on the target hex adds a point to the price; Surprise ignores them.
  const dug = sheller(5, 4, 2);
  assert.equal(shellCost(dug, dug.stacks[1]), 3);
  assert.equal(shell(dug, 'B1').active.points, 1);
  const surprise = play(Object.assign(duel(5, 4), { defense: { '2,2': 2 } }), 'S', 11);
  assert.equal(shellCost(surprise, surprise.stacks[1]), 1);
  // Not affordable, or not adjacent.
  assert.deepEqual(shellTargets(sheller(5, 4, 4)), []);
  const gap = sheller(5, 4);
  gap.stacks[1].col = 4;
  assert.deepEqual(shellTargets(gap), []);
  // Shelling does not use up the attack: both are paid from the same points.
  const combined = duelWithReserve(6, 4);
  const after = attack(shell(play(combined, 'S', 8), 'B1'), 'A1', 'B1', 2);
  assert.equal(after.casualties.B, 4, 'one shelled man, then 1 + 2 offensive points');
  // After a first attack the points must still cover the extra attack; shelling can spend them below that.
  const pair = duelWithReserve(4, 9);
  const spot = neighbors(2, 2).find((h) => inBounds(pair, h.col, h.row) && !stackAt(pair, h.col, h.row));
  pair.stacks.push({ ...structuredClone(pair.stacks[0]), id: 'A2', col: spot.col, row: spot.row });
  let volley = attack(play(pair, 'S', 8), 'A1', 'B1');
  assert.deepEqual(legalAttacks(volley, 'A2').map((s) => s.id), ['B1'], '4 points pay the extra attack');
  for (let i = 0; i < 3; i++) volley = shell(volley, 'B1');
  assert.equal(volley.active.points, 1);
  assert.deepEqual(legalAttacks(volley, 'A2'), [], 'one point no longer buys the extra attack');
});

test('an empty hex keeps at most one trench chip, however the stack left it', () => {
  // Walked away.
  const walker = gapDuel(5, 4);
  walker.defense['1,2'] = 3;
  const [hex] = legalMoves(walker, 'A1');
  assert.equal(moveStack(walker, 'A1', hex.col, hex.row).defense['1,2'], 1);
  assert.equal(walker.defense['1,2'], 3, 'a stack that stays keeps its trenches');
  // Retreated: the winner moves into a hex with a single chip.
  const dug = bare(duelWithReserve(9, 3));
  dug.defense['2,2'] = 3;
  let state = attack(dug, 'A1', 'B1');
  const [out] = retreatOptions(state);
  state = resolveRetreat(state, out.col, out.row);
  assert.equal(state.defense['2,2'], 1);
  // Destroyed.
  const wiped = bare(duelWithReserve(9, 1));
  wiped.defense['2,2'] = 3;
  assert.equal(attack(wiped, 'A1', 'B1').defense['2,2'], 1);
});

test('an attacker that wins an empty hex advances into it at full strength', () => {
  const state = attack(bare(duelWithReserve(6, 1)), 'A1', 'B1'); // B1 dies, A1 advances
  const attacker = state.stacks.find((s) => s.id === 'A1');
  assert.equal(attacker.col, 2);
  assert.equal(strength(state, attacker, false), attacker.men + attacker.gear);
});

test('every turn costs a nation a flat tick of exhaustion, and lost towns add to it', () => {
  let state = duel(3, 3);
  const tick = config.surrender.turnTick;
  state = endTurn(state);
  assert.deepEqual(state.exhaustion, { A: tick, B: 0 }, 'a nation ticks at the end of its own turn');
  state = endTurn(state);
  assert.deepEqual(state.exhaustion, { A: tick, B: tick });
  assert.equal(breakScore(state, 'A'), tick);
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
  state.stacks.push({ id: 'A9', owner: 'A', col: 1, row: 2, men: 3, gear: 0, spent: false });
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

// A small map with one named place at (2,2), on Player B's side of the border (columns 0-1 are A's).
function townGame(size) {
  return createGame(
    {
      cols: 7,
      rows: 5,
      borderCol: 1,
      terrain: {},
      places: [{ name: 'Testville', col: 2, row: 2, size }],
      capitals: { A: { col: 0, row: 0 }, B: { col: 6, row: 4 } },
      stacks: [
        { owner: 'A', col: 1, row: 2, men: 3 },
        { owner: 'B', col: 6, row: 0, men: 3 },
      ],
    },
    config,
  );
}

test('a town starts with its home nation; the enemy takes it by standing on it, and it costs exhaustion every turn', () => {
  const start = townGame('city');
  assert.deepEqual(start.towns.map((t) => [t.home, t.holder]), [['B', 'B']]);
  assert.equal(townsLost(start, 'B').length, 0);

  const taken = moveStack(start, 'A1', 2, 2);
  assert.equal(taken.towns[0].holder, 'A');
  assert.equal(townsLost(taken, 'B').length, 1);
  assert.ok(taken.log.some((l) => l.includes('captures Testville')));

  const tick = config.surrender.turnTick;
  const bTurn = endTurn(taken);
  assert.equal(bTurn.exhaustion.B, 0, 'the tick comes at the end of the loser\'s own turn');
  const again = endTurn(bTurn);
  assert.equal(again.exhaustion.B, tick + 1, 'the flat tick plus 1 for the lost city');
  assert.ok(breakScore(again, 'B') > breakScore(bTurn, 'B'), 'exhaustion counts towards the break score');
  assert.equal(endTurn(endTurn(again)).exhaustion.B, 2 * (tick + 1), 'and it keeps ticking while the town stays lost');
  assert.equal(again.exhaustion.A, tick, 'A pays only the flat tick');

  const heavy = townGame('big');
  heavy.surrender.bigTownWeight = 2;
  const big = endTurn(endTurn(moveStack(heavy, 'A1', 2, 2)));
  assert.equal(big.exhaustion.B, tick + 2, 'a big town can be weighted more than a small one');
});

// A1 sits at (1,2) behind a wall of B stacks at column 2; A's capital is out of reach on the far side.
function surrounded(gear) {
  const state = createGame(
    {
      cols: 7,
      rows: 5,
      borderCol: 1,
      terrain: {},
      capitals: { A: { col: 6, row: 0 }, B: { col: 6, row: 4 } },
      stacks: [
        { owner: 'A', col: 1, row: 2, men: 4 },
        ...[0, 1, 2, 3, 4].map((row) => ({ owner: 'B', col: 2, row, men: 3 })),
      ],
    },
    config,
  );
  state.stacks[0].gear = gear;
  return state;
}

test('a surrounded stack loses a gear chip on each of its own turns, then a man on each', () => {
  const turn = (state) => endTurn(endTurn(state)); // both players end their turn: it is A's turn again
  let state = surrounded(2);
  assert.equal(isCutOff(state, state.stacks[0]), true);
  const a = (s) => s.stacks.find((x) => x.id === 'A1');
  state = turn(state);
  assert.deepEqual([a(state).men, a(state).gear], [4, 1]);
  state = turn(state);
  assert.deepEqual([a(state).men, a(state).gear], [4, 0]);
  state = turn(state);
  assert.deepEqual([a(state).men, a(state).gear], [3, 0]);
  state = turn(state);
  assert.deepEqual([a(state).men, a(state).gear], [2, 0]);
  assert.equal(a(turn(surrounded(0))).men, 3, 'with no gear a man is lost straight away');
});

// A 9x5 map: columns 0-3 are Player A's. A holds the towns (1,1), (3,0) and (2,3) (where A1 stands); B has (6,2).
function muster() {
  return createGame(
    {
      cols: 9,
      rows: 5,
      borderCol: 3,
      terrain: {},
      places: [
        { name: 'Alpha', col: 1, row: 1, size: 'town' },
        { name: 'Beta', col: 3, row: 0, size: 'town' },
        { name: 'Gamma', col: 2, row: 3, size: 'city' },
        { name: 'Delta', col: 6, row: 2, size: 'town' },
      ],
      capitals: { A: { col: 0, row: 0 }, B: { col: 8, row: 4 } },
      stacks: [
        { owner: 'A', col: 2, row: 3, men: 3 },
        { owner: 'B', col: 8, row: 0, men: 3 },
      ],
    },
    config,
  );
}

test('the Willingness doctrine level sets how many recruits a nation musters each turn', () => {
  const state = muster();
  const counts = [0, 1, 2, 3].map((level) => recruitsFor(setDoctrine(state, 'A', { willingness: level }), 'A'));
  assert.deepEqual(counts, [1, 1, 2, 3]);
  assert.equal(state.recruits.A, 1, 'the first player starts with its recruits');
  assert.equal(state.recruits.B, 0);
  assert.equal(endTurn(state).recruits.B, 2, 'B has Willingness 2 in the test doctrines');
});

test('recruits muster as 1-man stacks in empty home towns, and unplaced ones are lost', () => {
  const state = muster();
  assert.deepEqual(recruitSites(state).map((h) => h.name), ['Alpha', 'Beta'], 'not the occupied or the enemy town');
  assert.throws(() => placeRecruit(state, 2, 3), /Cannot muster/);
  assert.throws(() => placeRecruit(state, 6, 2), /Cannot muster/);

  const placed = placeRecruit(state, 1, 1);
  const fresh = placed.stacks.find((s) => s.id === 'A2');
  assert.deepEqual([fresh.owner, fresh.men, fresh.gear, fresh.col, fresh.row], ['A', 1, 0, 1, 1]);
  assert.equal(placed.recruits.A, 0);
  assert.deepEqual(recruitSites(placed), [], 'no recruits left to place');
  assert.throws(() => placeRecruit(placed, 3, 0), /Cannot muster/);

  const taken = structuredClone(state);
  taken.towns.find((t) => t.name === 'Beta').holder = 'B';
  assert.deepEqual(recruitSites(taken).map((h) => h.name), ['Alpha'], 'a town the enemy holds cannot take recruits');

  const later = endTurn(endTurn(state));
  assert.equal(later.recruits.A, 1, 'unplaced recruits do not pile up');
  assert.equal(later.stacks.length, 2);
});

test('no recruits are mustered where the new stack would be surrounded', () => {
  const state = surrounded(0);
  state.towns = [{ name: 'Trapped', col: 0, row: 3, size: 'town', home: 'A', holder: 'A' }];
  assert.equal(state.recruits.A, 1);
  assert.deepEqual(recruitSites(state), []);
  state.stacks = state.stacks.filter((s) => s.owner === 'A');
  assert.equal(recruitSites(state).length, 1, 'with the wall gone the town is fine');
});
