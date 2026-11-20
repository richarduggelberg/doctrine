import { center, corners, edgeSegments, key } from './hex.js';
import { terrainAt, territoryOf } from './engine.js';

const SIZE = 36;
const CHIP_RADIUS = 21;
const CHIP_THICKNESS = 4;

export function renderBoard(svg, state, view) {
  const width = SIZE * Math.sqrt(3) * (state.cols + 0.5) + SIZE;
  const height = SIZE * 1.5 * state.rows + SIZE;
  svg.setAttribute('viewBox', `${-SIZE} ${-SIZE} ${width + SIZE} ${height + SIZE}`);

  const targets = new Set(view.targets.map((t) => key(t.col, t.row)));
  const parts = [];
  const border = [];

  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const { x, y } = center(col, row, SIZE);
      const classes = ['hex'];
      if (targets.has(key(col, row))) classes.push('target');
      const points = corners(x, y, SIZE - 1);
      parts.push(`<polygon class="${classes.join(' ')}" data-col="${col}" data-row="${row}" points="${points}"/>`);
      parts.push(`<polygon class="tint tint-${territoryOf(state, col)}" points="${points}"/>`);
      const home = territoryOf(state, col);
      const crossing = edgeSegments(col, row, SIZE, (c, r) => c >= 0 && c < state.cols && territoryOf(state, c) !== home);
      for (const [p, q] of crossing) {
        border.push(`<line class="border" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}"/>`);
      }
    }
  }
  parts.push(...border);

  for (const [owner, cap] of Object.entries(state.capitals)) {
    const { x, y } = center(cap.col, cap.row, SIZE);
    parts.push(`<text class="capital owner-${owner}" x="${x}" y="${y + SIZE * 0.86}" text-anchor="middle">★</text>`);
  }

  // Terrain chips (brown: 1 rough, 2 fortified) and trench chips (dark) sit in piles on the hex.
  // They never move or attack; like men they count only for the defender.
  const pile = (x, y, count, cls) => {
    for (let i = 0; i < count; i++) {
      parts.push(
        `<ellipse class="${cls}" cx="${x}" cy="${y - i * 4}" rx="10" ry="5.5"/>`,
      );
    }
  };
  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const { x, y } = center(col, row, SIZE);
      const terrain = terrainAt(state, col, row);
      const chips = terrain === 'fortified' ? 2 : terrain === 'rough' ? 1 : 0;
      pile(x - 22, y + 14, chips, 'terrain-chip');
      pile(x + 22, y + 14, state.defense[key(col, row)] ?? 0, 'trench-chip');
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
