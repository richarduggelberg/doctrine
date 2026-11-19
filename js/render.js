import { center, corners, key } from './hex.js';
import { terrainAt } from './engine.js';

const SIZE = 36;
const CHIP_RADIUS = 21;
const CHIP_THICKNESS = 5;

export function renderBoard(svg, state, view) {
  const width = SIZE * Math.sqrt(3) * (state.cols + 0.5) + SIZE;
  const height = SIZE * 1.5 * state.rows + SIZE;
  svg.setAttribute('viewBox', `${-SIZE} ${-SIZE} ${width + SIZE} ${height + SIZE}`);

  const targets = new Set(view.targets.map((t) => key(t.col, t.row)));
  const parts = [];

  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const { x, y } = center(col, row, SIZE);
      const terrain = terrainAt(state, col, row);
      const classes = ['hex', terrain];
      if (targets.has(key(col, row))) classes.push('target');
      parts.push(
        `<polygon class="${classes.join(' ')}" data-col="${col}" data-row="${row}" points="${corners(x, y, SIZE - 1)}"/>`,
      );
    }
  }

  for (const [owner, cap] of Object.entries(state.capitals)) {
    const { x, y } = center(cap.col, cap.row, SIZE);
    parts.push(`<text class="capital owner-${owner}" x="${x}" y="${y + SIZE * 0.86}" text-anchor="middle">★</text>`);
  }

  // Trench chips sit on the hex itself, whoever occupies it.
  for (const [hexKey, count] of Object.entries(state.defense)) {
    const [col, row] = hexKey.split(',').map(Number);
    const { x, y } = center(col, row, SIZE);
    for (let i = 0; i < count; i++) {
      parts.push(
        `<rect class="trench" x="${x - 30 + i * 11}" y="${y + 14}" width="9" height="9" rx="2"/>`,
      );
    }
  }

  // Draw back-to-front so lower rows overlap higher ones.
  const ordered = [...state.stacks].sort((a, b) => a.row - b.row);
  for (const stack of ordered) {
    const { x, y } = center(stack.col, stack.row, SIZE);
    const classes = ['stack', `owner-${stack.owner}`];
    if (stack.braced) classes.push('braced');
    if (view.eligible.has(stack.id)) classes.push('eligible');
    if (stack.id === view.selectedId) classes.push('selected');
    if (view.enemyTargets.has(stack.id)) classes.push('attackable');
    if (view.friendTargets.has(stack.id)) classes.push('mergeable');
    if (stack.id === view.loserId) classes.push('loser');
    const chips = [];
    for (let i = 0; i < stack.men + stack.gear; i++) {
      const cy = y + 6 - i * CHIP_THICKNESS;
      const kind = i < stack.men ? 'chip' : 'chip gear';
      chips.push(`<ellipse class="${kind}" cx="${x}" cy="${cy}" rx="${CHIP_RADIUS}" ry="${CHIP_RADIUS * 0.55}"/>`);
    }
    const topY = y + 6 - (stack.men + stack.gear - 1) * CHIP_THICKNESS;
    const label = stack.gear ? `${stack.men}+${stack.gear}` : `${stack.men}`;
    parts.push(
      `<g class="${classes.join(' ')}" data-stack="${stack.id}">` +
        `<ellipse class="halo" cx="${x}" cy="${y + 6}" rx="${CHIP_RADIUS + 4}" ry="${CHIP_RADIUS * 0.55 + 4}"/>` +
        chips.join('') +
        `<text class="count" x="${x}" y="${topY + 6}" text-anchor="middle">${label}</text>` +
        `</g>`,
    );
  }

  svg.innerHTML = parts.join('');
}
