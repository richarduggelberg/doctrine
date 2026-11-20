import {
  applyToStack, attack, breakScore, cardIssue, cardText, createGame, discardCard, doctrineLevel, eligibleStacks, endOrder, endTurn,
  getStack, isDirectOrder, legalAttacks, legalMerges, legalMoves, legalSplits, mergeStacks,
  moveStack, maxBonus, playCard, resolveHold, resolveRetreat, retreatOptions, splitStack, strength, terrainAt,
} from './engine.js';
import { renderBoard } from './render.js';

const $ = (id) => document.getElementById(id);
const svg = $('board');
const turnLabel = $('turn');
const infoPanel = $('info');
const logList = $('log');
const endTurnButton = $('end-turn');
const decisionPanel = $('decision');
const decisionText = $('decision-text');
const orderPanel = $('order');
const orderText = $('order-text');
const bonusEl = $('bonus');
const endOrderButton = $('end-order');
const statusLine = $('status');
const handEl = $('hand');
const handTitle = $('hand-title');
const coverPanel = $('cover');
const coverText = $('cover-text');
const overPanel = $('over');

const INSTRUCTIONS = {
  move: 'Select a highlighted stack, then an adjacent empty hex.',
  attack: 'Select a highlighted stack, then a red-dashed adjacent enemy.',
  merge: 'Select a highlighted stack, then a green-dashed adjacent friendly stack to merge into.',
  split: 'Select a highlighted stack, then an empty adjacent hex to send half of it there.',
  hold: 'Click a highlighted stack to dig it in.',
  entrench: 'Click a highlighted stack to add a trench to its hex.',
  rally: 'Click a highlighted stack to give it 1 gear.',
  martial: 'Click a highlighted stack: it loses 1 man.',
};

let map;
let config;
let state;
let selectedId = null;
let bonusChoice = 0;
// The hand stays hidden after a turn ends until the next player takes the device.
let covered = false;

async function start() {
  [map, config] = await Promise.all([
    fetch('data/map.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('data/cards.json', { cache: 'no-store' }).then((r) => r.json()),
  ]);
  newGame();
}

function newGame() {
  const setup = structuredClone(config);
  for (const p of ['A', 'B']) setup.doctrine[p].public = $(`declare-${p}`).checked;
  state = createGame(map, setup, Math.floor(Math.random() * 2 ** 31));
  selectedId = null;
  covered = false;
  draw();
}

function targetsFor(id) {
  if (!id || state.pending) return { hexes: [], enemies: [], friends: [] };
  return {
    hexes: [...legalMoves(state, id), ...legalSplits(state, id)],
    enemies: legalAttacks(state, id),
    friends: legalMerges(state, id),
  };
}

function draw() {
  const pending = state.pending;
  const t = targetsFor(selectedId);
  renderBoard(svg, state, {
    selectedId,
    targets: pending ? retreatOptions(state) : t.hexes,
    enemyTargets: new Set(t.enemies.map((s) => s.id)),
    friendTargets: new Set(t.friends.map((s) => s.id)),
    eligible: new Set(eligibleStacks(state).map((s) => s.id)),
    loserId: pending?.loserId,
  });
  turnLabel.textContent = `Turn ${state.turn} - Player ${state.current}`;
  turnLabel.className = `owner-${state.current}`;
  endTurnButton.disabled = Boolean(pending) || Boolean(state.over) || covered;
  drawInfo();
  drawStatus();
  drawOrder();
  drawDecision();
  drawHand();
  drawOver();
  logList.innerHTML = state.log
    .slice(-12)
    .reverse()
    .map((line) => `<li>${line}</li>`)
    .join('');
}

function drawInfo() {
  const stack = selectedId && getStack(state, selectedId);
  if (!stack) {
    infoPanel.textContent = 'Play a card from your hand, then use the highlighted stacks.';
    return;
  }
  const lines = [
    `${stack.id}: ${stack.men} men + ${stack.gear} gear on ${terrainAt(state, stack.col, stack.row)} ` +
      `(${stack.col},${stack.row}). Defends at ${strength(state, stack, true)}.`,
  ];
  for (const target of legalAttacks(state, stack.id)) {
    const bonus = bonusChoice;
    lines.push(
      `Attack ${target.id}: ${strength(state, stack, false) + bonus} vs ${strength(state, target, true)} ` +
        `(defender wins ties)`,
    );
  }
  infoPanel.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
}

function doctrineText(owner) {
  const { cards } = state.doctrine[owner];
  return Object.entries(cards)
    .map(([suit, n]) => `${config.symbols[suit]}${n}${n > state.maxLevel ? ` (L${state.maxLevel})` : ''}`)
    .join(' ');
}

function drawStatus() {
  const other = state.current === 'A' ? 'B' : 'A';
  const own = covered && !state.over && !state.doctrine[state.current].public
    ? 'hidden' : doctrineText(state.current);
  const theirs = state.doctrine[other].public ? doctrineText(other) : 'secret';
  statusLine.textContent =
    `Doctrine ${state.current}: ${own} | Doctrine ${other}: ${theirs} | Plays left: ${state.cardsPerTurn - state.played} | ` +
    `Discard: ${state.discardUsed ? 'used' : 'available'} | Deck: ${state.deck.length} | ` +
    `Player ${other} holds ${state.hands[other].length} cards | ` +
    `Break score A ${breakScore(state, 'A')}, B ${breakScore(state, 'B')} (thresholds hidden)`;
}

function drawOrder() {
  const active = state.active;
  orderPanel.hidden = !active;
  bonusEl.hidden = true;
  if (!active) return;
  const def = state.defs[active.card.type];
  const max = maxBonus(state);
  bonusChoice = Math.min(bonusChoice, max);
  const left = active.extraCost ? ` (${active.points} offensive points left)` : '';
  orderText.textContent = `${def.name}${left}: ${INSTRUCTIONS[active.kind]}`;
  if (active.kind === 'attack' && max > 0 && !state.pending) {
    bonusEl.hidden = false;
    bonusEl.innerHTML = 'Spend on this attack: ' + Array.from({ length: max + 1 }, (_, n) =>
      `<button data-bonus="${n}" class="${n === bonusChoice ? 'on' : ''}">+${n}</button>`).join('') +
      (active.used.length === 0 && active.points >= active.extraCost
        ? ` <small>(${active.extraCost} points buy an extra attack)</small>` : '');
  }
  endOrderButton.textContent = active.used.length ? 'Finish order' : 'Cancel order';
  endOrderButton.disabled = Boolean(state.pending);
}

function drawDecision() {
  const pending = state.pending;
  decisionPanel.hidden = !pending;
  if (!pending) return;
  const loser = getStack(state, pending.loserId);
  const canRetreat = retreatOptions(state).length > 0;
  decisionText.textContent =
    `Player ${loser.owner}: ${loser.id} is overpowered. Stand (lose 1 more man), ` +
    (canRetreat
      ? `or click a highlighted hex to retreat (lose ${loser.gear > 0 ? '1 gear' : '1 man'}).`
      : 'it cannot retreat.');
}

function drawOver() {
  const over = state.over;
  overPanel.hidden = !over;
  if (!over) return;
  $('over-title').textContent = `Player ${over.loser} surrenders - Player ${over.winner} wins`;
  $('over-reason').textContent = over.reason;
  const rows = ['A', 'B']
    .map((p) => `<tr><td>Player ${p}</td><td>${over.scores[p]}</td><td>${over.thresholds[p]}</td></tr>`)
    .join('');
  const doctrines = ['A', 'B']
    .map((p) => `<tr><td>Player ${p}</td><td colspan="2">${doctrineText(p)}${state.doctrine[p].public ? ' (declared)' : ' (secret)'}</td></tr>`)
    .join('');
  $('over-table').innerHTML =
    `<tr><th></th><th>Break score</th><th>Threshold</th></tr>${rows}` +
    `<tr><th></th><th colspan="2">Doctrine</th></tr>${doctrines}`;
}

function drawHand() {
  const hand = state.hands[state.current];
  coverPanel.hidden = !covered || Boolean(state.over);
  if (covered && !state.over) {
    handTitle.textContent = '';
    coverText.textContent = `Pass the device to Player ${state.current}.`;
    handEl.innerHTML = '';
    return;
  }
  handTitle.textContent = `Player ${state.current}'s hand`;
  handEl.innerHTML = hand
    .map((card) => {
      const def = state.defs[card.type];
      const issue = cardIssue(state, card);
      return (
        `<div class="card-wrap">` +
        `<button class="card suit-${def.suit}" data-uid="${card.uid}" ${issue ? 'disabled' : ''} ` +
        `title="${issue ?? 'Play this card'}">` +
        `<span class="card-name">${def.name}</span>` +
        `<span class="card-suit">${config.symbols[def.suit]} ${def.suit}` +
        `${def.suit === 'general' ? '' : ` · L${doctrineLevel(state, state.current, def.suit)}`}</span>` +
        `<span class="card-text">${cardText(state, state.current, def)}</span></button>` +
        `<button class="discard" data-discard="${card.uid}" ${state.discardUsed || state.pending ? 'disabled' : ''}>` +
        `Discard</button></div>`
      );
    })
    .join('');
}

function attempt(action) {
  try {
    state = action();
  } catch (error) {
    state = { ...state, log: [...state.log, `Not allowed: ${error.message}`] };
  }
  selectedId = null;
  bonusChoice = 0;
  draw();
}

function inList(list, col, row) {
  return list.some((h) => h.col === col && h.row === row);
}

svg.addEventListener('click', (event) => {
  if (state.pending) {
    const hexEl = event.target.closest('[data-col]');
    if (hexEl) {
      const col = Number(hexEl.dataset.col);
      const row = Number(hexEl.dataset.row);
      if (inList(retreatOptions(state), col, row)) attempt(() => resolveRetreat(state, col, row));
    }
    return;
  }

  const stackEl = event.target.closest('[data-stack]');
  if (stackEl) {
    const id = stackEl.dataset.stack;
    const t = targetsFor(selectedId);
    if (t.enemies.some((s) => s.id === id)) return attempt(() => attack(state, selectedId, id, bonusChoice));
    if (t.friends.some((s) => s.id === id)) return attempt(() => mergeStacks(state, selectedId, id));
    const canUse = eligibleStacks(state).some((s) => s.id === id);
    if (canUse && isDirectOrder(state)) return attempt(() => applyToStack(state, id));
    selectedId = selectedId === id ? null : id;
    draw();
    return;
  }

  const hexEl = event.target.closest('[data-col]');
  if (hexEl && selectedId) {
    const col = Number(hexEl.dataset.col);
    const row = Number(hexEl.dataset.row);
    const id = selectedId;
    if (inList(legalMoves(state, id), col, row)) return attempt(() => moveStack(state, id, col, row));
    if (inList(legalSplits(state, id), col, row)) return attempt(() => splitStack(state, id, col, row));
  }
  selectedId = null;
  draw();
});

handEl.addEventListener('click', (event) => {
  const play = event.target.closest('[data-uid]');
  const discard = event.target.closest('[data-discard]');
  if (play && !play.disabled) attempt(() => playCard(state, play.dataset.uid));
  else if (discard && !discard.disabled) attempt(() => discardCard(state, discard.dataset.discard));
});

bonusEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-bonus]');
  if (!button) return;
  bonusChoice = Number(button.dataset.bonus);
  draw();
});
$('hold').addEventListener('click', () => attempt(() => resolveHold(state)));
endOrderButton.addEventListener('click', () => attempt(() => endOrder(state)));
endTurnButton.addEventListener('click', () => {
  attempt(() => endTurn(state));
  covered = !state.over;
  draw();
});
$('reveal').addEventListener('click', () => {
  covered = false;
  draw();
});
$('over-new').addEventListener('click', newGame);
$('new-game').addEventListener('click', newGame);

start();
