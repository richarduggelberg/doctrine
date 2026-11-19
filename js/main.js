import {
  attack, createGame, endTurn, getStack, legalAttacks, legalMoves, moveStack,
  resolveHold, resolveRetreat, retreatOptions, strength, terrainAt,
} from './engine.js';
import { renderBoard } from './render.js';

const svg = document.getElementById('board');
const turnLabel = document.getElementById('turn');
const infoPanel = document.getElementById('info');
const logList = document.getElementById('log');
const endTurnButton = document.getElementById('end-turn');
const newGameButton = document.getElementById('new-game');
const decisionPanel = document.getElementById('decision');
const decisionText = document.getElementById('decision-text');
const holdButton = document.getElementById('hold');

let map;
let state;
let selectedId = null;

async function start() {
  map = await (await fetch('data/map.json')).json();
  newGame();
}

function newGame() {
  state = createGame(map);
  selectedId = null;
  draw();
}

function draw() {
  const pending = state.pending;
  const targets = pending
    ? retreatOptions(state)
    : selectedId ? legalMoves(state, selectedId) : [];
  const attackable = new Set(
    !pending && selectedId ? legalAttacks(state, selectedId).map((s) => s.id) : [],
  );
  renderBoard(svg, state, { selectedId, targets, attackable, loserId: pending?.loserId });
  turnLabel.textContent = `Turn ${state.turn} - Player ${state.current}`;
  turnLabel.className = `owner-${state.current}`;
  endTurnButton.disabled = Boolean(pending);
  drawInfo();
  drawDecision();
  logList.innerHTML = state.log
    .slice(-12)
    .reverse()
    .map((line) => `<li>${line}</li>`)
    .join('');
}

function drawInfo() {
  const stack = selectedId && getStack(state, selectedId);
  if (!stack) {
    infoPanel.textContent =
      'Click one of your stacks, then a highlighted hex to move it, or a red-dashed enemy to attack it.';
    return;
  }
  const lines = [
    `${stack.id}: ${stack.men} men + ${stack.gear} gear on ${terrainAt(state, stack.col, stack.row)} ` +
      `(${stack.col},${stack.row}). ${stack.acted ? 'Already acted.' : 'Ready.'}`,
  ];
  for (const target of legalAttacks(state, stack.id)) {
    lines.push(
      `Attack ${target.id}: ${strength(state, stack, false)} vs ${strength(state, target, true)} ` +
        `(defender wins ties)`,
    );
  }
  infoPanel.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
}

function drawDecision() {
  const pending = state.pending;
  decisionPanel.hidden = !pending;
  if (!pending) return;
  const loser = getStack(state, pending.loserId);
  const canRetreat = retreatOptions(state).length > 0;
  decisionText.textContent =
    `Player ${loser.owner}: ${loser.id} lost the battle. Hold (lose 2 men), ` +
    (canRetreat
      ? 'or click a highlighted hex to retreat (lose 1 man + 1 gear).'
      : 'it cannot retreat.');
}

svg.addEventListener('click', (event) => {
  if (state.pending) {
    const hexEl = event.target.closest('[data-col]');
    if (hexEl) {
      const col = Number(hexEl.dataset.col);
      const row = Number(hexEl.dataset.row);
      if (retreatOptions(state).some((o) => o.col === col && o.row === row)) {
        state = resolveRetreat(state, col, row);
        selectedId = null;
        draw();
      }
    }
    return;
  }

  const stackEl = event.target.closest('[data-stack]');
  if (stackEl) {
    const id = stackEl.dataset.stack;
    if (selectedId && legalAttacks(state, selectedId).some((t) => t.id === id)) {
      state = attack(state, selectedId, id);
      selectedId = null;
    } else {
      selectedId = selectedId === id ? null : id;
    }
    draw();
    return;
  }
  const hexEl = event.target.closest('[data-col]');
  if (hexEl && selectedId) {
    const col = Number(hexEl.dataset.col);
    const row = Number(hexEl.dataset.row);
    if (legalMoves(state, selectedId).some((m) => m.col === col && m.row === row)) {
      state = moveStack(state, selectedId, col, row);
    }
  }
  selectedId = null;
  draw();
});

holdButton.addEventListener('click', () => {
  state = resolveHold(state);
  selectedId = null;
  draw();
});

endTurnButton.addEventListener('click', () => {
  state = endTurn(state);
  selectedId = null;
  draw();
});

newGameButton.addEventListener('click', newGame);

start();
