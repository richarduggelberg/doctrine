import {
  applyPool, applyToStack, attack, breakScore, canPayEntry, cardIssue, cardText, chooseMode, createGame, discardCard,
  doctrineLevel, eligibleStacks, endOrder, endTurn, getStack, inEnemyZoc, isCutOff, isDirectOrder, legalAssaults, legalAttacks,
  legalMerges, legalMoves, legalSplits, mergeStacks, moveStack, maxBonus, needsTarget, playCard, resolveHold,
  resolveRetreat, retreatOptions, splitStack, strength, terrainBonus, featuresAt,
} from './engine.js';
import { renderBoard } from './render.js';

const $ = (id) => document.getElementById(id);

// e.g. "Verdun hills+river+fortress (+4 terrain)" for the selection info.
function describeTerrain(col, row) {
  const features = featuresAt(state, col, row);
  if (!features.length) return 'open ground';
  return `${features.join('+')} (+${terrainBonus(state, col, row)} terrain)`;
}
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
const modesEl = $('modes');
const endOrderButton = $('end-order');
const statusLine = $('status');
const handEl = $('hand');
const handTitle = $('hand-title');
const coverPanel = $('cover');
const coverText = $('cover-text');
const overPanel = $('over');

const INSTRUCTIONS = {
  attack: 'Select a highlighted stack, then a red-dashed adjacent enemy, or an orange entry hex to assault (step in and attack).',
  hold: 'Click a highlighted stack to dig it in.',
  fortify: 'Click a highlighted stack to add a trench chip to its hex.',
  'logistics:rail': 'Click a highlighted stack: it may step 1 more hex this turn.',
  'logistics:rally': 'Click a highlighted stack to give it 1 gear.',
  'logistics:merge': 'Select a highlighted stack, then a green-dashed adjacent friendly stack to merge into.',
  'logistics:split': 'Select a highlighted stack, then an empty adjacent hex to send half of it there.',
  logistics: 'Choose what to spend points on.',
  'homefront:recruit': 'Click a highlighted stack in your home territory to add 1 man.',
  homefront: 'Choose what to spend points on.',
};

const MODE_LABELS = {
  fortify: 'Trench', rail: 'Rail +1 hex', rally: 'Rally +1 gear', merge: 'Merge', split: 'Split',
  propaganda: 'Propaganda +1 resolve', relief: 'Relief -2 weariness', recruit: 'Recruit +1 man',
};

let map;
let config;
let state;
let selectedId = null;
let bonusChoice = 0;
// An assault first steps into an entry hex; paying 2 points avoids the hasty -2 strength penalty.
let entry = null;
let payEntry = false;
// The hand stays hidden after a turn ends until the next player takes the device.
let covered = false;

async function start() {
  [map, config] = await Promise.all([
    fetch('data/map.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('data/cards.json', { cache: 'no-store' }).then((r) => r.json()),
  ]);
  newGame();
}

function resetPicks() {
  selectedId = null;
  bonusChoice = 0;
  entry = null;
  payEntry = false;
}

function newGame() {
  const setup = structuredClone(config);
  for (const p of ['A', 'B']) setup.doctrine[p].public = $(`declare-${p}`).checked;
  state = createGame(map, setup, Math.floor(Math.random() * 2 ** 31));
  resetPicks();
  covered = false;
  draw();
}

// The entry hex chosen for an assault, if it is still valid for the selected stack.
function chosenEntry(assaults) {
  return entry && assaults.find((e) => e.col === entry.col && e.row === entry.row);
}

function targetsFor(id) {
  if (!id || state.pending) return { hexes: [], entries: [], enemies: [], friends: [] };
  const assaults = legalAssaults(state, id);
  const chosen = chosenEntry(assaults);
  return {
    hexes: [...(state.active ? [] : legalMoves(state, id)), ...legalSplits(state, id)],
    entries: chosen ? [chosen] : assaults,
    enemies: chosen ? chosen.targets : legalAttacks(state, id),
    friends: legalMerges(state, id),
  };
}

function enemyZone() {
  const zone = new Set();
  if (!$('show-zoc').checked || covered || state.over) return zone;
  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      if (inEnemyZoc(state, state.current, col, row)) zone.add(`${col},${row}`);
    }
  }
  return zone;
}

function draw() {
  const pending = state.pending;
  const t = targetsFor(selectedId);
  const mover = !state.active && !pending && !state.over && !covered;
  renderBoard(svg, state, {
    selectedId,
    targets: pending ? retreatOptions(state) : t.hexes,
    entries: new Set(t.entries.map((e) => `${e.col},${e.row}`)),
    zoc: enemyZone(),
    movable: new Set(mover ? state.stacks.filter((s) => legalMoves(state, s.id).length > 0).map((s) => s.id) : []),
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
    infoPanel.textContent = 'Play a card from your hand, then use the highlighted stacks. Without an order you can still step a stack 1 hex (dotted halo) outside enemy zones.';
    return;
  }
  const lines = [
    `${stack.id}${stack.army ? ` (${stack.army})` : ''}: ${stack.men} men chips${state.menPerChip ? ` (~${(stack.men * state.menPerChip).toLocaleString('en-US')} soldiers)` : ''} + ${stack.gear} gear on ${describeTerrain(stack.col, stack.row)} ` +
      `(${stack.col},${stack.row}). Defends at ${strength(state, stack, true)}.` +
      `${stack.fought ? ' Fought this turn: cannot step.' : stack.moved ? ' Already stepped this turn.' : ''}` +
      `${isCutOff(state, stack) ? ' CUT OFF: no supply path home, it can do nothing.' : ''}`,
  ];
  const assaults = legalAssaults(state, stack.id);
  const chosen = chosenEntry(assaults);
  const hasty = state.assault.hastyPenalty;
  const penalty = chosen && !state.active.freeEntry && !payEntry ? hasty : 0;
  for (const target of chosen ? chosen.targets : legalAttacks(state, stack.id)) {
    lines.push(
      `${chosen ? 'Assault' : 'Attack'} ${target.id}: ${strength(state, stack, false) + bonusChoice - penalty} vs ` +
        `${strength(state, target, true)} (a tie is a stalemate)${penalty ? ` - hasty -${penalty}` : ''}`,
    );
  }
  if (!chosen && assaults.length) lines.push('Orange hexes: assault entries (step in, then attack).');
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
    `Break score A ${breakScore(state, 'A')}, B ${breakScore(state, 'B')} (thresholds hidden) | ` +
    `Weariness A ${state.weariness.A}, B ${state.weariness.B}` +
    ['A', 'B'].filter((p) => state.siege[p]).map((p) => ` | ${p} holds the enemy capital: wins if it survives the enemy turn`).join('');
}

function drawOrder() {
  const active = state.active;
  orderPanel.hidden = !active;
  bonusEl.hidden = true;
  modesEl.hidden = true;
  if (!active) return;
  const def = state.defs[active.card.type];
  const pool = Boolean(active.menu);
  const chosen = selectedId && chosenEntry(legalAssaults(state, selectedId));
  const paying = Boolean(chosen) && payEntry;
  if (!chosen) payEntry = false;
  const max = maxBonus(state, paying);
  bonusChoice = Math.min(bonusChoice, max);
  const left = active.extraCost || pool ? ` (${active.points} points left)` : '';
  const key = pool && active.mode ? `${active.kind}:${active.mode}` : active.kind;
  orderText.textContent = `${def.name}${left}: ${INSTRUCTIONS[key] ?? INSTRUCTIONS[active.kind]}`;
  if (pool && Object.keys(active.menu).length > 1) {
    modesEl.hidden = false;
    modesEl.innerHTML = Object.entries(active.menu).map(([mode, cost]) =>
      `<button data-mode="${mode}" class="${mode === active.mode ? 'on' : ''}" ${active.points < cost ? 'disabled' : ''}>` +
      `${MODE_LABELS[mode]} (${cost})</button>`).join(' ');
  }
  if (active.kind === 'attack' && !state.pending) {
    const entryChoice = chosen && !active.freeEntry
      ? `Entry: <button data-pay="0" class="${paying ? '' : 'on'}">Hasty -${state.assault.hastyPenalty} strength</button>` +
        `<button data-pay="1" class="${paying ? 'on' : ''}" ${canPayEntry(state) ? '' : 'disabled'}>Pay ${state.assault.entryCost} points</button> `
      : '';
    if (entryChoice || max > 0) {
      bonusEl.hidden = false;
      bonusEl.innerHTML = entryChoice + (max > 0 ? 'Spend on this attack: ' + Array.from({ length: max + 1 }, (_, n) =>
        `<button data-bonus="${n}" class="${n === bonusChoice ? 'on' : ''}">+${n}</button>`).join('') : '') +
        (active.used.length === 0 && active.extraCost && active.points >= active.extraCost
          ? ` <small>(${active.extraCost} points buy an extra attack)</small>` : '');
    }
  }
  endOrderButton.textContent = active.acted || active.used.length ? 'Finish order' : 'Cancel order';
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
  $('over-title').textContent = `Player ${over.loser} is defeated - Player ${over.winner} wins`;
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
  resetPicks();
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
    if (t.enemies.some((s) => s.id === id)) {
      const from = selectedId;
      const chosen = chosenEntry(legalAssaults(state, from));
      const paid = payEntry;
      const bonus = bonusChoice;
      return attempt(() => attack(state, from, id, bonus, chosen ? { col: chosen.col, row: chosen.row } : null, paid));
    }
    if (t.friends.some((s) => s.id === id)) return attempt(() => mergeStacks(state, selectedId, id));
    const canUse = eligibleStacks(state).some((s) => s.id === id);
    if (canUse && isDirectOrder(state)) return attempt(() => applyToStack(state, id));
    entry = null;
    payEntry = false;
    selectedId = selectedId === id ? null : id;
    draw();
    return;
  }

  const hexEl = event.target.closest('[data-col]');
  if (hexEl && selectedId) {
    const col = Number(hexEl.dataset.col);
    const row = Number(hexEl.dataset.row);
    const id = selectedId;
    if (!state.active && inList(legalMoves(state, id), col, row)) return attempt(() => moveStack(state, id, col, row));
    if (inList(legalSplits(state, id), col, row)) return attempt(() => splitStack(state, id, col, row));
    const entries = legalAssaults(state, id);
    if (inList(entries, col, row)) {
      const same = entry && entry.col === col && entry.row === row;
      entry = same ? null : { col, row };
      draw();
      return;
    }
  }
  resetPicks();
  draw();
});

handEl.addEventListener('click', (event) => {
  const play = event.target.closest('[data-uid]');
  const discard = event.target.closest('[data-discard]');
  if (play && !play.disabled) attempt(() => playCard(state, play.dataset.uid));
  else if (discard && !discard.disabled) attempt(() => discardCard(state, discard.dataset.discard));
});

bonusEl.addEventListener('click', (event) => {
  const pay = event.target.closest('[data-pay]');
  if (pay && !pay.disabled) payEntry = pay.dataset.pay === '1';
  const button = event.target.closest('[data-bonus]');
  if (button) bonusChoice = Number(button.dataset.bonus);
  draw();
});

modesEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (!button || button.disabled) return;
  const mode = button.dataset.mode;
  attempt(() => {
    const next = chooseMode(state, mode);
    return needsTarget(mode) ? next : applyPool(next, mode);
  });
});
$('show-zoc').addEventListener('change', draw);
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
