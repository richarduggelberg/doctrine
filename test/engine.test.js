import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyPool, applyToStack, attack, breakScore, cardIssue, chooseMode, countryAt, createGame, discardCard, eligibleStacks, endOrder,
  endTurn, featuresAt, fortification, frontOwners, improvise, improviseIssue, inBounds, inEnemyZoc, isCutOff, legalAttacks, legalMerges, legalMoves, legalSplits,
  mergeStacks, moveStack, orderTier, setIssue, playCard, resolveRetreat, retreatOptions, shell, shellCost,
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

function playSet(state, suit, ...ranks) {
  let given = state;
  for (const rank of ranks) given = give(given, suit, rank);
  const hand = given.hands[given.current];
  return playCard(given, ...hand.slice(-ranks.length).map((c) => c.uid));
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
  const state = duel(3, 4);
  const tiers = (owner, suit) => [2, 4, 5, 7, 8, 10, 11, 13, 14].map((r) => orderTier(state, owner, suit, r));
  // A has 3 aggressive cards (+1), 2 reorganizational (0), 1 defensive (-1) and no willingness (-2).
  assert.deepEqual(tiers('A', 'aggressive'), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
  assert.deepEqual(tiers('A', 'reorganizational'), [0, 0, 1, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual(tiers('A', 'defensive'), [0, 0, 0, 0, 1, 1, 2, 2, 3]);
  assert.deepEqual(tiers('B', 'aggressive'), [0, 0, 0, 0, 0, 0, 1, 1, 2], 'no doctrine: tiers are clamped at 0');
  assert.equal(play(state, 'S', 9).active.points, 5); // an 8-10 under level 3 plays as a face card (tier 3)
  assert.equal(play(state, 'S', 3).active.points, 3);
  assert.equal(play(endTurn(state), 'S', 9).active.points, 1, 'the lowest tier still has 1 point');
  assert.equal(play(setDoctrine(state, 'A', { aggressive: 9 }), 'S', 9).active.points, 5, 'level is capped');
});

test('same-suit cards played as a set add their points, plus 1 per card beyond the first; faces lose their abilities', () => {
  const state = duel(3, 3);
  const pair = playSet(state, 'S', 2, 3);
  assert.equal(pair.active.points, 7, '3 + 3 for the cards, +1 for the pair');
  assert.equal(pair.played, 1, 'one order');
  assert.equal(playSet(state, 'S', 2, 3, 5).active.points, 12, '3 + 3 + 4, +2 for three cards');
  const faces = playSet(state, 'S', 11, 4);
  assert.equal(faces.active.points, 10, 'a face counts as its tier: 6 + 3, +1');
  assert.equal(faces.active.name, 'Offensive', 'its ability is lost');
  assert.equal(faces.active.fx.ignoreTrenches, undefined);
  const defence = playSet(endTurn(state), 'C', 2, 3).active;
  assert.deepEqual([defence.points, defence.values.limit], [5, 2], 'points add up; the trench limit is the strongest card\'s');
  const mixed = give(give(state, 'S', 2), 'C', 3);
  const hand = mixed.hands.A;
  assert.match(setIssue(mixed, hand.slice(-2)), /same suit/);
  assert.throws(() => playCard(mixed, hand.at(-2).uid, hand.at(-1).uid));
});

test('face cards add abilities: Offensive Surprise, No quarter and Breakthrough', () => {
  // Surprise: trench chips do not count for the defender, in strength or in cost.
  const dug = duel(5, 3);
  dug.defense['2,2'] = 2;
  const tie = attack(play(dug, 'S', 6), 'A1', 'B1'); // 5 against 3 + 2 trenches is a tie: a grind\r\n  assert.equal(tie.pending, null);\r\n  assert.deepEqual(tie.stacks.map((s) => s.men), [4, 2]);
  const surprised = attack(play(dug, 'S', 11), 'A1', 'B1');
  assert.equal(surprised.pending.winnerId, 'A1');
  assert.equal(surprised.stacks[0].men, 4, 'the trenches cost the attacker nothing: 1 man');
  // No quarter: a beaten defender cannot retreat, so it stands and loses 2 men.
  assert.ok(retreatOptions(attack(play(duel(5, 3), 'S', 5), 'A1', 'B1')).length > 0);
  const noQuarter = attack(play(duel(5, 3), 'S', 13), 'A1', 'B1');
  assert.equal(noQuarter.pending, null);
  assert.equal(noQuarter.stacks.find((s) => s.id === 'B1').men, 1);
  // Breakthrough: the beaten defender loses a man more.
  const advance = (card) => {
    const won = attack(play(duelWithReserve(6, 4), 'S', card), 'A1', 'B1');
    const [hex] = retreatOptions(won);
    return resolveRetreat(won, hex.col, hex.row);
  };
  const normal = advance(5);
  assert.equal(normal.stacks.find((s) => s.id === 'B1').men, 3);
  const through = advance(14);
  assert.equal(through.stacks.find((s) => s.id === 'B1').men, 2);
  // Combined arms: attacks are free and shelled men cost 1 point.
  const combined = play(duel(3, 3), 'S', 12).active;
  assert.deepEqual([combined.attackCost, combined.manCost], [0, 1]);
});

test('face cards add abilities for the other suits', () => {
  const b = endTurn(duel(3, 3)); // Player B: 3 defensive (+1), 2 willingness (0), 1 reorganizational (-1)
  assert.equal(play(b, 'C', 11).elastic.B, true, 'Elastic defence at once');
  assert.ok(play(b, 'C', 12).defense['2,2'] === 1, 'Reserves entrenches the stack facing the enemy');
  const wall = play(b, 'C', 13).active;
  assert.deepEqual([wall.values.points, wall.values.limit], [5, 4], 'Iron wall: +1 point, one deeper trenches');
  assert.equal(applyToStack(chooseMode(play(duel(3, 3), 'D', 11), 'rail'), 'A1').stacks[0].rail, 6, 'Rail net');
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

test('Rail adds hexes to a stack\'s walk, but only along its own soil', () => {
  const wide = (stackCol) =>
    createGame(
      {
        cols: 14,
        rows: 5,
        terrain: {},
        capitals: { A: { col: 0, row: 0 }, B: { col: 13, row: 4 } },
        stacks: [
          { owner: 'A', col: stackCol, row: 2, men: 3 },
          { owner: 'B', col: 13, row: 2, men: 3 },
        ],
      },
      config,
    ); // borderCol 6: columns 0-6 are A's
  const railed = (s) => applyToStack(chooseMode(play(s, 'D', 2), 'rail'), 'A1');
  let state = railed(wide(0));
  assert.equal(state.stacks[0].rail, 4);
  const reach = legalMoves(state, 'A1');
  assert.equal(Math.max(...reach.map((h) => h.dist)), 6, '2 hexes of walking + 4 of rail');
  assert.ok(reach.every((h) => h.col <= 6), 'rail never leaves home soil');
  state = moveStack(state, 'A1', 6, 2);
  assert.equal(state.stacks[0].moved, 6);
  assert.deepEqual(legalMoves(state, 'A1'), []);
  // Near the border only the ordinary 2-hex walk crosses it.
  const edge = legalMoves(railed(wide(5)), 'A1');
  assert.ok(edge.some((h) => h.col === 7 && h.dist === 2), 'the plain walk still crosses the border');
  assert.ok(edge.every((h) => h.col <= 6 || h.dist <= 2), 'no rail beyond the border');
  assert.ok(edge.some((h) => h.col === 0 && h.dist === 5), 'rail runs deep on home soil');
  // A stack standing on foreign soil gets no rail benefit.
  const abroad = railed(wide(5));
  abroad.stacks[0].col = 8;
  assert.ok(legalMoves(abroad, 'A1').every((h) => h.dist <= 2));
  assert.throws(() => play(wide(8), 'D', 2), /No stack/, 'no rail for a stack abroad');
});

test('entering a hex with terrain or trench chips ends the walk, unless the stack has rail', () => {
  const hilly = () => {
    const state = duel(3, 3, { '2,2': 'hills' });
    state.borderCol = 3;
    state.stacks[1].col = 4;
    return state;
  };
  const onHills = moveStack(hilly(), 'A1', 2, 2);
  assert.equal(onHills.stacks[0].stalled, true);
  assert.deepEqual(legalMoves(onHills, 'A1'), [], 'a hill ends the walk');
  const dug = gapDuel(3, 3);
  dug.defense['2,2'] = 1;
  assert.deepEqual(legalMoves(moveStack(dug, 'A1', 2, 2), 'A1'), [], 'a trench chip counts too');
  const clear = moveStack(gapDuel(3, 3), 'A1', 2, 2);
  assert.equal(clear.stacks[0].stalled, false);
  assert.ok(legalMoves(clear, 'A1').length > 0, 'clear ground leaves the second hex');
  // Rail runs through rough ground on home soil, even if the stack already stopped on it.
  const railed = applyToStack(chooseMode(play(hilly(), 'D', 2), 'rail'), 'A1');
  assert.ok(legalMoves(moveStack(railed, 'A1', 2, 2), 'A1').length > 0);
  const stopped = applyToStack(chooseMode(play(moveStack(hilly(), 'A1', 2, 2), 'D', 2), 'rail'), 'A1');
  assert.ok(legalMoves(stopped, 'A1').length > 0);
});

test('rail can be given to a stack only once per turn', () => {
  let state = chooseMode(play(duel(3, 3), 'D', 8), 'rail'); // 2 points
  assert.deepEqual(eligibleStacks(state).map((s) => s.id), ['A1']);
  state = applyToStack(state, 'A1');
  assert.equal(state.active.points, 1);
  assert.deepEqual(eligibleStacks(state), [], 'A1 already has rail');
  assert.throws(() => applyToStack(state, 'A1'));
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

test('terrain and trenches add to defense; a tie is no assault but can be ground', () => {
  assert.equal(bare(duel(3, 3)).active.points, 1, 'a tier-0 order still has 1 point: enough to grind an even fight');
  const tie = attack(play(duel(3, 3), 'S', 6), 'A1', 'B1');
  assert.equal(tie.pending, null, 'a tie is a grind, not an assault');
  assert.deepEqual(tie.stacks.map((s) => [s.men, s.col]), [[2, 1], [2, 2]]);
  const rough = duel(4, 3, { '2,2': 'rough' });
  assert.equal(strength(rough, rough.stacks[1], true), 4);
  assert.equal(attack(play(rough, 'S', 6), 'A1', 'B1').pending, null, 'a tie against rough ground is a grind too');
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

test('a failed assault is not allowed: the attacker grinds, both sides lose the same men and nobody moves', () => {
  const state = attack(play(duel(3, 5), 'S', 6), 'A1', 'B1');
  assert.equal(state.pending, null);
  assert.equal(state.stacks.find((s) => s.id === 'A1').men, 2);
  const defender = state.stacks.find((s) => s.id === 'B1');
  assert.deepEqual([defender.men, defender.gear, defender.col], [4, 0, 2]);
  assert.equal(state.stacks.find((s) => s.id === 'A1').col, 1);
  assert.equal(state.active, null, 'the only stack has acted: the order ends');
});

test('an assault costs the attacker men and drives the defender out; the attacker gains gear only when it advances', () => {
  let state = fight(5, 3);
  assert.equal(state.pending.winnerId, 'A1');
  assert.equal(state.stacks[0].men, 4); // paid 1 for the ground
  assert.equal(state.stacks[0].gear, 0, 'no gear until the hex is taken');
  assert.equal(state.stacks[1].men, 3, 'the defender loses nothing but the ground');
  const options = retreatOptions(state);
  assert.ok(options.length > 0);
  for (const o of options) assert.ok(!inEnemyZoc(state, 'B', o.col, o.row), 'a retreat must leave every enemy zone');
  state = resolveRetreat(state, options[0].col, options[0].row);
  assert.equal(state.stacks.find((s) => s.id === 'B1').men, 2); // no gear: the retreat costs a man
  assert.deepEqual([state.stacks[0].col, state.stacks[0].row], [2, 2]);
  assert.equal(state.stacks[0].gear, 1);
  assert.equal(state.pending, null);
  assert.equal(state.casualties.A + state.casualties.B, 2);
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
  assert.deepEqual([retreated.men, retreated.gear], [3, 0]);
});

test('a pocketed defender (no retreat) stands and loses 2 men and keeps the hex; destroyed stacks vanish', () => {
  const held = attack(play(duelWithReserve(5, 3), 'S', 13), 'A1', 'B1'); // No quarter pockets it
  assert.equal(held.pending, null);
  assert.equal(held.stacks.find((s) => s.id === 'B1').men, 1);
  assert.deepEqual([held.stacks[0].col, held.stacks[0].row], [1, 2]);
  assert.equal(held.stacks[0].gear, 0);
  const destroyed = fight(5, 1); // a lone man has no chip to spare for a retreat
  assert.equal(destroyed.stacks.length, 1);
  assert.deepEqual([destroyed.stacks[0].col, destroyed.stacks[0].row], [2, 2]);
  assert.equal(destroyed.pending, null);
});

test('other actions are blocked while a battle awaits a decision', () => {
  const state = fight(5, 3);
  assert.throws(() => endTurn(state));
  assert.throws(() => attack(state, 'A1', 'B1'));
});

test('a stack that fought cannot walk any more, and a stack that walked cannot fight', () => {
  const fought = attack(bare(duelWithReserve(5, 3)), 'A1', 'B1');
  const [hex] = retreatOptions(fought);
  const done = resolveRetreat(fought, hex.col, hex.row);
  assert.equal(done.stacks.find((s) => s.id === 'A1').fought, true);
  assert.deepEqual(legalMoves(done, 'A1'), []);
  // Walking up to the enemy uses the action: the stack cannot attack from there this turn.
  const walked = moveStack(gapDuel(6, 3), 'A1', 3, 2);
  assert.throws(() => play(walked, 'S', 6), /No stack/);
});

test('a failed attack grinds 1 for 1 and nobody moves; an assault costs only the attacker men', () => {
  assert.equal(bare(duel(4, 3)).active.points, 1, 'a tier-0 order has 1 point');
  const ground = attack(play(duel(4, 4), 'S', 6), 'A1', 'B1'); // a tie
  assert.deepEqual(ground.stacks.map((s) => s.men), [3, 3]);
  assert.equal(ground.active, null, 'nobody is left to attack: the order ends');
  assert.throws(() => play(duel(2, 2), 'S', 6), /No stack/, 'a defender is never ground below 2 men: it can only be assaulted');
  assert.deepEqual(legalAttacks(play(duel(3, 2), 'S', 6), 'A1').map((s) => s.id), ['B1'], 'but a win is still an assault');
  const strong = attack(play(duelWithReserve(5, 4), 'S', 6), 'A1', 'B1');
  assert.equal(strong.pending.winnerId, 'A1');
  assert.deepEqual([strong.stacks[0].men, strong.stacks.find((s) => s.id === 'B1').men], [4, 4], 'only the attacker pays');
});

test('every attack costs 1 point (none with Combined arms); one stack attacks only once', () => {
  const state = createGame(
    {
      cols: 7,
      rows: 5,
      terrain: {},
      capitals: { A: { col: 0, row: 0 }, B: { col: 6, row: 4 } },
      stacks: [
        { owner: 'A', col: 1, row: 2, men: 6 },
        { owner: 'A', col: 2, row: 3, men: 6 },
        { owner: 'B', col: 2, row: 2, men: 3 },
        { owner: 'B', col: 3, row: 3, men: 3 },
      ],
    },
    config,
  );
  let s = attack(play(state, 'S', 6), 'A1', 'B1'); // 4 points
  assert.equal(s.pending.winnerId, 'A1');
  assert.equal(s.active.points, 3);
  const [out] = retreatOptions(s);
  s = resolveRetreat(s, out.col, out.row);
  assert.deepEqual(legalAttacks(s, 'A1'), [], 'A1 has already acted');
  assert.ok(eligibleStacks(s).every((st) => st.id !== 'A1'));
  s = attack(s, 'A2', 'B2');
  assert.equal(s.active.points, 2);
  const [out2] = retreatOptions(s);
  s = resolveRetreat(s, out2.col, out2.row);
  assert.equal(s.active, null, 'every stack has attacked: the order ends');

  // A 1-point order pays for one attack only.
  const weak = play(setDoctrine(state, 'A', { aggressive: 0 }), 'S', 2);
  assert.equal(weak.active.points, 1);
  const spent = attack(weak, 'A1', 'B1');
  assert.equal(spent.active.points, 0);
  assert.deepEqual(legalAttacks(spent, 'A2'), [], 'no points left for another attack');

  // Combined arms makes attacks free.
  const free = attack(play(state, 'S', 12), 'A1', 'B1');
  assert.equal(free.active.points, play(state, 'S', 12).active.points);
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
  assert.equal(spy.active.points, 3, 'a rank 2 is tier 0, lifted to tier 1 by the level-3 offensive doctrine');
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
  const pair = give(give(duel(4, 3), 'C', 5), 'C', 6);
  const [p, q] = pair.hands.A.slice(-2);
  assert.match(improviseIssue(pair, p, p, 'aggressive'), /different/);
  const noTarget = structuredClone(pair);
  noTarget.stacks[0].col = 0; // out of reach of every enemy stack
  assert.match(improviseIssue(noTarget, p, q, 'aggressive'), /No stack/);
  assert.equal(improviseIssue(noTarget, p, q, 'defensive'), null);
  // The doctrine shift of the chosen suit applies: Player A's level-3 offensive lifts a rank 2 one tier.
  const strong = improvise(pair, p.uid, q.uid, 'aggressive');
  const weak = improvise(setDoctrine(pair, 'A', { aggressive: 0 }), p.uid, q.uid, 'aggressive');
  assert.equal(strong.active.points, 3);
  assert.equal(weak.active.points, 1);
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

test('bloodletting: the attacker pays men for terrain and trenches; the defender loses nothing but the ground, unless broken through', () => {
  assert.equal(fight(6, 3, { '2,2': 'fortified' }).stacks[0].men, 4); // paid 2
  const dug = bare(duel(9, 3, { '2,2': 'rough' }));
  dug.defense['2,2'] = 2;
  assert.equal(attack(dug, 'A1', 'B1').stacks[0].men, 6); // rough + 2 trenches: paid 3
  assert.equal(attack(play(duel(9, 5), 'S', 6), 'A1', 'B1').stacks.find((s) => s.id === 'B1').men, 5);
  assert.equal(attack(play(duel(9, 5), 'S', 14), 'A1', 'B1').stacks.find((s) => s.id === 'B1').men, 4, 'Breakthrough costs it 1 man');
});

test('an attacker needs more men than the attack costs, so it cannot destroy itself', () => {
  const rough = { '2,2': 'fortified' }; // an attacker pays 2 here
  const thin = duel(2, 1, rough);
  thin.stacks[0].gear = 2;
  assert.throws(() => bare(thin), /No stack/, '4 against 3 would win, but it costs 2 men of 2');
  const ok = duel(3, 1, rough);
  ok.stacks[0].gear = 1;
  const won = attack(bare(ok), 'A1', 'B1');
  assert.equal(won.stacks[0].men, 1, 'it survives with its last man');
  assert.deepEqual(legalAttacks(bare(duel(2, 1)), 'A1').map((s) => s.id), ['B1'], 'flat ground costs 1');
});

test('if both nations are wiped out at once, the one that lost more men loses', () => {
  const wipe = (casualties) => {
    const state = duel(3, 3);
    state.stacks = [];
    state.casualties = casualties;
    return endTurn(state);
  };
  assert.equal(wipe({ A: 5, B: 2 }).over.loser, 'A');
  assert.equal(wipe({ A: 2, B: 5 }).over.loser, 'B');
});

test('artillery strips trench chips down to 1, then takes men for 2 points each, never below 2 men', () => {
  // A second shooter next to B1, since each stack shells only once per turn.
  const pairOf = (a, b, trenches = 0, rank = 8) => {
    const state = duelWithReserve(a, b);
    const spot = neighbors(2, 2).find((h) => inBounds(state, h.col, h.row) && !stackAt(state, h.col, h.row));
    state.stacks.push({ ...structuredClone(state.stacks[0]), id: 'A2', col: spot.col, row: spot.row });
    if (trenches) state.defense['2,2'] = trenches;
    return play(state, 'S', rank); // an 8 is tier 3 for A: 5 points
  };
  const men = (state, id) => state.stacks.find((s) => s.id === id).men;
  // Chips go first, 1 point each, without hurting either stack.
  let state = pairOf(5, 4, 2);
  assert.deepEqual(shellTargets(state, 'A1').map((s) => s.id), ['B1']);
  state = shell(state, 'A1', 'B1');
  assert.deepEqual([men(state, 'A1'), state.stacks.find((s) => s.id === 'A1').fought, men(state, 'B1')], [5, true, 4]);
  assert.deepEqual([state.active.points, state.defense['2,2']], [4, 1]);
  assert.deepEqual(shellTargets(state, 'A1'), [], 'a stack shells once');
  assert.throws(() => shell(state, 'A1', 'B1'));
  assert.throws(() => attack(state, 'A1', 'B1'), /Illegal attack/, 'a shooter cannot also assault');
  // The last chip stays; a man then costs 2 points.
  assert.equal(shellCost(state, state.stacks.find((s) => s.id === 'B1')), 2);
  state = shell(state, 'A2', 'B1');
  assert.deepEqual([men(state, 'B1'), state.defense['2,2'], state.casualties.B], [3, 1, 1]);
  assert.equal(state.active, null, 'both shooters have fired: the order ends with points to spare');
  assert.deepEqual(shellTargets(state, 'A2'), []);

  // A bare hex goes straight to men, and a stack of 2 men is beyond artillery.
  const bareHex = pairOf(5, 3, 0, 13); // a king is tier 4: 6 points
  const once = shell(bareHex, 'A1', 'B1');
  assert.deepEqual([men(once, 'B1'), once.active.points], [2, 4]);
  assert.deepEqual(shellTargets(once, 'A2'), []);
  // Surprise strips 2 chips per point, still leaving 1; Combined arms makes a man cost 1.
  const surprise = shell(pairOf(5, 4, 4, 11), 'A1', 'B1');
  assert.deepEqual([surprise.defense['2,2'], surprise.active.points], [2, 5]);
  const combined = pairOf(5, 4, 0, 12);
  assert.equal(shellCost(combined, combined.stacks.find((s) => s.id === 'B1')), 1);
  // Shooters must be adjacent.
  const gap = pairOf(5, 4);
  gap.stacks.find((s) => s.id === 'B1').col = 4;
  assert.deepEqual(shellTargets(gap, 'A1'), []);
  // A shell from one stack softens the target for an assault by another.
  const softened = attack(shell(pairOf(5, 3, 2), 'A1', 'B1'), 'A2', 'B1');
  assert.equal(softened.stacks.find((s) => s.id === 'A2').fought, true);
  assert.ok(softened.pending || men(softened, 'B1') < 3, 'the assault won: B1 retreats or, pocketed, stands and bleeds');
});

test('merging and splitting use the stack action, so a stack that walked can do neither', () => {
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
  const merged = mergeStacks(chooseMode(play(base, 'D', 8), 'merge'), 'A2', 'A1');
  assert.equal(merged.stacks.find((s) => s.id === 'A1').fought, true, 'merging is the stack action');
  const armed = chooseMode(play(base, 'D', 8), 'split');
  const [hex] = legalSplits(armed, 'A1');
  assert.equal(splitStack(armed, 'A1', hex.col, hex.row).stacks.find((s) => s.id === 'A1').fought, true);
  // After a walk neither is allowed.
  const [step] = legalMoves(base, 'A1');
  const walked = moveStack(base, 'A1', step.col, step.row);
  assert.deepEqual(legalSplits(chooseMode(play(walked, 'D', 8), 'split'), 'A1'), []);
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

test('a stack touching a supplied friendly stack is not cut off, even if that friend sits in an enemy zone', () => {
  const build = (stacks) => createGame(
    { cols: 7, rows: 5, borderCol: 1, terrain: {}, capitals: { A: { col: 0, row: 2 }, B: { col: 6, row: 4 } }, stacks },
    config,
  );
  const wall = [[2, 1], [3, 2], [2, 3], [1, 3], [1, 1]].map(([col, row]) => ({ owner: 'B', col, row, men: 3 }));
  const linked = build([{ owner: 'A', col: 2, row: 2, men: 3 }, { owner: 'A', col: 1, row: 2, men: 3 }, ...wall]);
  assert.equal(inEnemyZoc(linked, 'A', 1, 2), true, 'the link itself is under enemy guns');
  assert.equal(isCutOff(linked, linked.stacks[0]), false, 'A1 is supplied through A2, which touches the capital');
  const alone = build([{ owner: 'A', col: 2, row: 2, men: 3 }, ...wall]);
  assert.equal(isCutOff(alone, alone.stacks[0]), true, 'without the friendly link it is surrounded');
  const walled = build([{ owner: 'A', col: 3, row: 2, men: 3 }, { owner: 'A', col: 2, row: 2, men: 3 },
    ...[[3, 1], [4, 2], [3, 3], [2, 1], [2, 3], [1, 1], [1, 3]].map(([col, row]) => ({ owner: 'B', col, row, men: 3 }))]);
  assert.deepEqual(walled.stacks.slice(0, 2).map((s) => isCutOff(walled, s)), [true, true], 'a surrounded pair is still cut off');
});

test('supply must reach the capital or a held town within the supply range', () => {
  const build = (col, places = []) => createGame(
    { cols: 20, rows: 5, borderCol: 15, terrain: {}, places, capitals: { A: { col: 0, row: 2 }, B: { col: 19, row: 4 } },
      stacks: [{ owner: 'A', col, row: 2, men: 3 }, { owner: 'B', col: 19, row: 0, men: 3 }] },
    config,
  );
  const cut = (state) => isCutOff(state, state.stacks[0]);
  assert.equal(cut(build(config.supplyRange)), false, 'just inside the range of the capital');
  assert.equal(cut(build(config.supplyRange + 1)), true, 'one hex too far');
  const depot = { col: 10, row: 2, name: 'Depot', size: 'small' };
  assert.equal(cut(build(14, [depot])), false, 'a held town is a supply depot');
  const taken = build(14, [depot]);
  taken.towns[0].holder = 'B';
  assert.equal(cut(taken), true, 'a town the enemy holds is not');
});

test('a cut-off stack exerts no zone of control', () => {
  const free = duel(3, 3);
  assert.equal(inEnemyZoc(free, 'B', 0, 2), true, 'a supplied A1 controls the hex behind it');
  const trapped = surrounded(0);
  assert.equal(isCutOff(trapped, trapped.stacks[0]), true);
  assert.equal(inEnemyZoc(trapped, 'B', 0, 2), false, 'but a surrounded one does not');
  assert.equal(inEnemyZoc(trapped, 'A', 3, 2), true, 'its captors still do');
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
