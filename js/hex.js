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

export function center(col, row, size) {
  return {
    x: size * Math.sqrt(3) * (col + 0.5 * (Math.abs(row) % 2)),
    y: size * 1.5 * row,
  };
}

export function corners(cx, cy, size) {
  const points = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(cx + size * Math.cos(angle)).toFixed(2)},${(cy + size * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(' ');
}
