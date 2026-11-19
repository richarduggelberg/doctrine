import { createGame, endTurn, getStack, legalMoves, moveStack, terrainAt } from './engine.js';
import { renderBoard } from './render.js';

const svg = document.getElementById('board');
const turnLabel = document.getElementById('turn');
const infoPanel = document.getElementById('info');
const logList = document.getElementById('log');
const endTurnButton = document.getElementById('end-turn');
const newGameButton = document.getElementById('new-game');

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
  const targets = selectedId ? legalMoves(state, selectedId) : [];
  renderBoard(svg, state, { selectedId, targets });
  turnLabel.textContent = `Turn ${state.turn} - Player ${state.current}`;
  turnLabel.className = `owner-${state.current}`;
  drawInfo();
  logList.innerHTML = state.log
    .slice(-12)
    .reverse()
    .map((line) => `<li>${line}</li>`)
    .join('');
}

function drawInfo() {
  const stack = selectedId && getStack(state, selectedId);
  if (!stack) {
    infoPanel.textContent = 'Click one of your stacks, then a highlighted hex to move it.';
    return;
  }
  infoPanel.textContent =
    `${stack.id}: ${stack.men} men on ${terrainAt(state, stack.col, stack.row)} ` +
    `(${stack.col},${stack.row}). ` +
    (stack.acted ? 'Already acted this turn.' : 'Ready.');
}

svg.addEventListener('click', (event) => {
  const stackEl = event.target.closest('[data-stack]');
  if (stackEl) {
    const id = stackEl.dataset.stack;
    selectedId = selectedId === id ? null : id;
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

endTurnButton.addEventListener('click', () => {
  state = endTurn(state);
  selectedId = null;
  draw();
});

newGameButton.addEventListener('click', newGame);

start();
