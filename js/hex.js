// Pointy-top hexes, "odd-r" offset coordinates (odd rows shifted right).

const EVEN_ROW = [[1, 0], [-1, 0], [0, -1], [-1, -1], [0, 1], [-1, 1]];
const ODD_ROW = [[1, 0], [-1, 0], [1, -1], [0, -1], [1, 1], [0, 1]];

export function key(col, row) {
  return `${col},${row}`;
}

export function neighbors(col, row) {
  const deltas = Math.abs(row) % 2 === 0 ? EVEN_ROW : ODD_ROW;
  return deltas.map(([dc, dr]) => ({ col: col + dc, row: row + dr }));
}

export function distance(a, b) {
  const toCube = ({ col, row }) => {
    const x = col - (row - (row & 1)) / 2;
    return { x, y: -x - row, z: row };
  };
  const p = toCube(a);
  const q = toCube(b);
  return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y), Math.abs(p.z - q.z));
}

export function center(col, row, size) {
  return {
    x: size * Math.sqrt(3) * (col + 0.5 * (Math.abs(row) % 2)),
    y: size * 1.5 * row,
  };
}

export function corners(cx, cy, size) {
  return cornerPoints(cx, cy, size).map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

export function cornerPoints(cx, cy, size) {
  const points = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return points;
}

// Neighbor offset for each hex edge, in the order edge i joins corner i and i+1
// (E, SE, SW, W, NW, NE).
const EDGE_EVEN = [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];
const EDGE_ODD = [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]];

// Line segments for the edges of a hex whose neighbor satisfies `isOther`.
export function edgeSegments(col, row, size, isOther) {
  const { x, y } = center(col, row, size);
  const pts = cornerPoints(x, y, size);
  const deltas = Math.abs(row) % 2 === 0 ? EDGE_EVEN : EDGE_ODD;
  const segments = [];
  deltas.forEach(([dc, dr], i) => {
    if (isOther(col + dc, row + dr)) segments.push([pts[i], pts[(i + 1) % 6]]);
  });
  return segments;
}
