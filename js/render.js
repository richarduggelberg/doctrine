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

  // Everything on a hex is one pile of equal chips, bottom to top: terrain (1 rough, 2 fortified),
  // trench chips, men, gear. Terrain and trenches never move or attack but count for the defender.
  const stackAt = new Map(state.stacks.map((s) => [key(s.col, s.row), s]));
  const piles = [];
  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const terrain = terrainAt(state, col, row);
      const terrainChips = terrain === 'fortified' ? 2 : terrain === 'rough' ? 1 : 0;
      const trenchChips = state.defense[key(col, row)] ?? 0;
      const stack = stackAt.get(key(col, row));
      if (terrainChips || trenchChips || stack) piles.push({ col, row, terrainChips, trenchChips, stack });
    }
  }

  // Draw back-to-front so lower rows overlap higher ones.
  piles.sort((a, b) => a.row - b.row || a.col - b.col);
  for (const { col, row, terrainChips, trenchChips, stack } of piles) {
    const { x, y } = center(col, row, SIZE);
    const kinds = [
      ...Array(terrainChips).fill('terrain-chip'),
      ...Array(trenchChips).fill('trench-chip'),
      ...(stack ? [...Array(stack.men).fill('chip'), ...Array(stack.gear).fill('chip gear')] : []),
    ];
    const thickness = kinds.length > 10 ? 3 : CHIP_THICKNESS;
    const chips = kinds.map(
      (kind, i) =>
        `<ellipse class="${kind}" cx="${x}" cy="${y + 6 - i * thickness}" rx="${CHIP_RADIUS}" ry="${CHIP_RADIUS * 0.55}"/>`,
    );
    if (!stack) {
      parts.push(`<g class="pile">${chips.join('')}</g>`);
      continue;
    }
    const classes = ['stack', `owner-${stack.owner}`];
    if (stack.braced) classes.push('braced');
    if (stack.spent) classes.push('spent');
    if (view.eligible.has(stack.id)) classes.push('eligible');
    if (stack.id === view.selectedId) classes.push('selected');
    if (view.enemyTargets.has(stack.id)) classes.push('attackable');
    if (view.friendTargets.has(stack.id)) classes.push('mergeable');
    if (stack.id === view.loserId) classes.push('loser');
    const topY = y + 6 - (kinds.length - 1) * thickness;
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
