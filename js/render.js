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

  // Draw back-to-front so lower rows overlap higher ones.
  const ordered = [...state.stacks].sort((a, b) => a.row - b.row);
  for (const stack of ordered) {
    const { x, y } = center(stack.col, stack.row, SIZE);
    const classes = ['stack', `owner-${stack.owner}`];
    if (stack.acted) classes.push('acted');
    if (stack.id === view.selectedId) classes.push('selected');
    const chips = [];
    for (let i = 0; i < stack.men; i++) {
      const cy = y + 6 - i * CHIP_THICKNESS;
      chips.push(`<ellipse class="chip" cx="${x}" cy="${cy}" rx="${CHIP_RADIUS}" ry="${CHIP_RADIUS * 0.55}"/>`);
    }
    const topY = y + 6 - (stack.men - 1) * CHIP_THICKNESS;
    parts.push(
      `<g class="${classes.join(' ')}" data-stack="${stack.id}">` +
        `<ellipse class="halo" cx="${x}" cy="${y + 6}" rx="${CHIP_RADIUS + 4}" ry="${CHIP_RADIUS * 0.55 + 4}"/>` +
        chips.join('') +
        `<text class="count" x="${x}" y="${topY + 6}" text-anchor="middle">${stack.men}</text>` +
        `</g>`,
    );
  }

  svg.innerHTML = parts.join('');
}
