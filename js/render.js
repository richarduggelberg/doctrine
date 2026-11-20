import { center, corners, edgeSegments, key } from './hex.js';
import { featuresAt, inBounds, isCutOff, strength, TERRAIN_BONUS, territoryOf, countryAt } from './engine.js';

const SIZE = 36;
const CHIP_RADIUS = 21;
const CHIP_THICKNESS = 4;
// The one feature that colours a hex, strongest first; the rest still show as terrain chips.
const FILL_ORDER = ['mountain', 'fortified', 'fortress', 'bigcity', 'city', 'hills', 'forest', 'marsh', 'rough'];

// Country labels are stored in hex units (u across, v down); this turns them into SVG pixels.
const px = ([u, v]) => `${(SIZE * Math.sqrt(3) * u).toFixed(1)},${(SIZE * 1.5 * v).toFixed(1)}`;

export function renderBoard(svg, state, view) {
  const width = SIZE * Math.sqrt(3) * (state.cols + 0.5) + SIZE;
  const height = SIZE * 1.5 * state.rows + SIZE;
  svg.setAttribute('viewBox', `${-SIZE} ${-SIZE} ${width + SIZE} ${height + SIZE}`);

  const targets = new Set(view.targets.map((t) => key(t.col, t.row)));
  const parts = [];
  const scenery = state.scenery;

  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const { x, y } = center(col, row, SIZE);
      const points = corners(x, y, SIZE - 1);
      if (!inBounds(state, col, row)) {
        parts.push(`<polygon class="hex sea" points="${points}"/>`);
        continue;
      }
      const features = featuresAt(state, col, row);
      const classes = ['hex', FILL_ORDER.find((f) => features.includes(f)) ?? 'open'];
      if (targets.has(key(col, row))) classes.push('target');
      parts.push(`<polygon class="${classes.join(' ')}" data-col="${col}" data-row="${row}" points="${points}"/>`);
      if (view.zoc.has(key(col, row))) parts.push(`<polygon class="zoc" points="${points}"/>`);
      const home = countryAt(state, col, row) ?? territoryOf(state, col, row);
      parts.push(`<polygon class="tint tint-${home}" points="${points}"/>`);
    }
  }

  // Rivers run through the middles of their hexes; borders follow hex edges (one line per shared edge).
  for (const river of scenery.rivers) {
    const line = river.hexes.map(([c, r]) => { const p = center(c, r, SIZE); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; });
    parts.push(`<polyline class="${river.big ? 'river big' : 'river'}" points="${line.join(' ')}"/>`);
  }
  if (state.countries) {
    for (let row = 0; row < state.rows; row++) {
      for (let col = 0; col < state.cols; col++) {
        const home = countryAt(state, col, row);
        if (home === '~') continue;
        const segments = edgeSegments(col, row, SIZE, (c, r) => {
          const other = c >= 0 && r >= 0 && c < state.cols && r < state.rows ? countryAt(state, c, r) : '~';
          return other !== '~' && other > home;
        });
        for (const [p, q] of segments) {
          parts.push(`<line class="border" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}"/>`);
        }
      }
    }
  }
  for (const label of scenery.countryLabels) {
    const [x, y] = px(label.at).split(',');
    parts.push(`<text class="country" x="${x}" y="${y}" text-anchor="middle">${label.name.toUpperCase()}</text>`);
  }

  for (const place of scenery.places) {
    const { x, y } = center(place.col, place.row, SIZE);
    parts.push(`<text class="place" x="${x}" y="${y - SIZE * 0.62}" text-anchor="middle">${place.name}</text>`);
  }

  for (const [owner, cap] of Object.entries(state.capitals)) {
    const { x, y } = center(cap.col, cap.row, SIZE);
    parts.push(`<text class="capital owner-${owner}" x="${x}" y="${y + SIZE * 0.86}" text-anchor="middle">★</text>`);
  }

  // Everything on a hex is one pile of equal chips, bottom to top: terrain (one per point of every
  // modifier, coloured by modifier), trench chips, men, gear. Terrain and trenches never move or attack
  // but count for the defender.
  const stackAt = new Map(state.stacks.map((s) => [key(s.col, s.row), s]));
  const piles = [];
  for (let row = 0; row < state.rows; row++) {
    for (let col = 0; col < state.cols; col++) {
      const terrainChips = featuresAt(state, col, row).flatMap((f) => Array(TERRAIN_BONUS[f] ?? 0).fill(`terrain-chip f-${f}`));
      const trenchChips = state.defense[key(col, row)] ?? 0;
      const stack = stackAt.get(key(col, row));
      if (terrainChips.length || trenchChips || stack) piles.push({ col, row, terrainChips, trenchChips, stack });
    }
  }

  // Draw back-to-front so lower rows overlap higher ones.
  piles.sort((a, b) => a.row - b.row || a.col - b.col);
  for (const { col, row, terrainChips, trenchChips, stack } of piles) {
    const { x, y } = center(col, row, SIZE);
    const kinds = [
      ...terrainChips,
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
    if (view.movable.has(stack.id)) classes.push('movable');
    if (stack.id === view.selectedId) classes.push('selected');
    if (view.enemyTargets.has(stack.id)) classes.push('attackable');
    if (view.friendTargets.has(stack.id)) classes.push('mergeable');
    if (stack.id === view.loserId) classes.push('loser');
    if (isCutOff(state, stack)) classes.push('cutoff');
    const topY = y + 6 - (kinds.length - 1) * thickness;
    // Big number: strength when defending (terrain, trenches, brace included). Small: the mobile part that attacks.
    const defend = strength(state, stack, true);
    const offence = strength(state, stack, false);
    parts.push(
      `<g class="${classes.join(' ')}" data-stack="${stack.id}">` +
        `<ellipse class="halo" cx="${x}" cy="${y + 6}" rx="${CHIP_RADIUS + 4}" ry="${CHIP_RADIUS * 0.55 + 4}"/>` +
        chips.join('') +
        `<text class="count" x="${x}" y="${topY + 6}" text-anchor="middle">${defend}` +
        `<tspan class="attack" dx="3">/${offence}</tspan></text>` +
        `</g>`,
    );
  }

  svg.innerHTML = parts.join('');
}
