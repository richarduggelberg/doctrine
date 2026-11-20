// Builds data/map.json: the Western Front, Paris to the Ruhr (Channel coast to the Vosges).
// Everything is placed by real longitude/latitude, then snapped to hexes: the sea, the five countries
// (France, Germany, Belgium, the Netherlands, Luxembourg), terrain (forest, hills, mountains, marsh),
// rivers and cities. Run: node tools/genmap.mjs [--ascii]
import { writeFileSync } from 'node:fs';
import { distance, neighbors } from '../js/hex.js';

const COLS = 25;
const ROWS = 26;
const HEX_KM = 20; // distance between neighbouring hex centres
const LON0 = 1.0; // centre of hex (0,0)
const LAT0 = 52.4;
const KM_PER_LAT = 111;
const KM_PER_LON = 70.9; // at about 50.4 N
const ROW_KM = (HEX_KM * Math.sqrt(3)) / 2;

const lonLat = (col, row) => ({
  lon: LON0 + (HEX_KM * (col + 0.5 * (row & 1))) / KM_PER_LON,
  lat: LAT0 - (ROW_KM * row) / KM_PER_LAT,
});
// Hex units: u counts hex widths east, v counts rows south. The renderer turns these into pixels.
const toUV = ([lon, lat]) => [((lon - LON0) * KM_PER_LON) / HEX_KM, ((LAT0 - lat) * KM_PER_LAT) / ROW_KM];
const round = ([u, v]) => [Math.round(u * 100) / 100, Math.round(v * 100) / 100];

// Pointy-top, odd-r offset: the hex containing a point given in hex units.
function hexAt([u, v]) {
  const x = u * Math.sqrt(3);
  const y = v * 1.5;
  const q = (Math.sqrt(3) / 3) * x - y / 3;
  const r = (2 / 3) * y;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(-q - r);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs + q + r);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { col: rq + (rr - (rr & 1)) / 2, row: rr };
}

function inPolygon({ lon, lat }, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inCircle = ({ lon, lat }, [cx, cy, km]) =>
  Math.hypot((lon - cx) * KM_PER_LON, (lat - cy) * KM_PER_LAT) <= km;

// ---------------------------------------------------------------- sea
// The Channel and North Sea: everything north-west of the coast.
const SEA = [
  [0.5, 49.8], [0.9, 49.8], [1.08, 49.93], [1.37, 50.06], [1.5, 50.2], [1.58, 50.4], [1.6, 50.73], [1.58, 50.87],
  [1.85, 50.97], [2.37, 51.06], [2.75, 51.15], [2.92, 51.24], [3.2, 51.34], [3.37, 51.38], [3.5, 51.45],
  [3.45, 51.55], [3.7, 51.68], [3.95, 51.78], [4.1, 51.95], [4.3, 52.1], [4.55, 52.4], [4.7, 52.7],
  [4.7, 53.5], [0.5, 53.5],
];

// ---------------------------------------------------------------- countries (borders as of 1914)
// Each border is a chain shared by two countries; the polygons below are built from them.
const FB = [ // France-Belgium, from the coast to the tripoint with Luxembourg
  [2.545, 51.089], [2.62, 51.06], [2.6, 50.98], [2.65, 50.85], [2.9, 50.72], [3.1, 50.76], [3.27, 50.7], [3.28, 50.56],
  [3.6, 50.47], [3.68, 50.4], [3.85, 50.35], [4.05, 50.32], [4.22, 50.18], [4.3, 50.0], [4.5, 49.97], [4.72, 50.05],
  [4.88, 50.13], [4.85, 49.98], [5.05, 49.9], [5.14, 49.7], [5.4, 49.52], [5.5, 49.55], [5.82, 49.55],
];
const FL = [[5.82, 49.55], [5.94, 49.48]]; // France-Luxembourg
// France-Germany: Germany held Alsace and German Lorraine (Metz, Thionville) until 1918.
const FG = [
  [5.94, 49.48], [5.95, 49.2], [6.02, 48.98], [6.3, 48.85], [6.5, 48.75], [6.72, 48.65], [6.9, 48.55], [7.1, 48.45],
  [7.05, 48.3], [7.0, 47.5],
];
const LB = [ // Luxembourg-Belgium, south to north
  [5.82, 49.55], [5.73, 49.7], [5.74, 49.83], [5.81, 49.97], [5.97, 50.1], [6.03, 50.18],
];
const LG = [ // Luxembourg-Germany
  [5.94, 49.48], [6.15, 49.46], [6.37, 49.47], [6.5, 49.72], [6.42, 49.81], [6.3, 49.85], [6.14, 49.95],
  [6.13, 50.13], [6.03, 50.18],
];
const BG = [[6.03, 50.18], [5.97, 50.3], [5.95, 50.5], [6.0, 50.65], [6.02, 50.75]]; // Belgium-Germany
const BN = [ // Belgium-Netherlands, from the coast
  [3.37, 51.38], [3.6, 51.3], [3.8, 51.27], [4.1, 51.25], [4.25, 51.38], [4.4, 51.43], [4.6, 51.43], [4.8, 51.47],
  [5.0, 51.47], [5.1, 51.4], [5.25, 51.3], [5.5, 51.3], [5.55, 51.2], [5.7, 51.0], [5.75, 50.85], [5.7, 50.77],
  [5.85, 50.75], [6.02, 50.75],
];
const NG = [ // Netherlands-Germany, south to north
  [6.02, 50.75], [6.07, 50.9], [6.1, 51.05], [6.2, 51.2], [6.2, 51.4], [6.05, 51.6], [5.95, 51.75], [6.15, 51.83],
  [6.4, 51.85], [6.75, 51.95], [7.05, 52.2], [7.1, 52.4], [7.2, 53.0],
];
const rev = (chain) => [...chain].reverse();

const COUNTRIES = {
  F: { name: 'France', polygon: [[0, 45], [0, 51.3], ...FB, ...FL, ...FG, [7.0, 45]], label: [1.9, 49.3] },
  E: { name: 'Belgium', polygon: [[2.545, 51.089], [2.4, 51.3], [3.2, 51.5], ...BN, ...rev(BG), ...rev(LB), ...rev(FB)], label: [4.3, 50.2] },
  L: { name: 'Luxembourg', polygon: [...LB, ...rev(LG), ...FL], label: [5.95, 49.9] },
  N: { name: 'Netherlands', polygon: [[3.37, 51.38], [3.0, 53.0], ...rev(NG), ...rev(BN)], label: [5.3, 52.05] },
  G: { name: 'Germany', polygon: [...NG, [9.5, 53.0], [9.5, 46.5], [7.0, 46.5], ...rev(FG), ...LG, ...BG], label: [7.6, 49.3] },
};
const OWNERS = { F: 'A', G: 'B' }; // France is Player A, Germany Player B; the rest is neutral ground
const BORDER_LINES = [
  ['F', 'E', FB], ['F', 'L', FL], ['F', 'G', FG], ['L', 'E', LB], ['L', 'G', LG], ['E', 'G', BG], ['E', 'N', BN], ['N', 'G', NG],
];

// ---------------------------------------------------------------- terrain areas (first match wins, top down)
const MOUNTAINS = [
  [[6.95, 48.4], [7.2, 48.4], [7.35, 48.6], [7.3, 48.8], [7.1, 48.7], [7.0, 48.55]], // Vosges crest
];
const HILLS = [
  [[6.5, 48.3], [6.8, 48.7], [7.0, 48.9], [7.5, 49.0], [7.45, 48.6], [7.4, 48.3]], // Vosges foothills
  [[6.1, 50.6], [6.9, 50.65], [7.3, 50.35], [7.2, 49.9], [6.6, 49.8], [6.2, 49.95], [6.1, 50.3]], // Eifel and Hohes Venn
  [[7.1, 49.75], [8.1, 49.75], [8.1, 50.1], [7.4, 50.05]], // Hunsruck
  [[3.2, 49.36], [3.2, 49.43], [3.9, 49.52], [3.9, 49.43]], // Chemin des Dames
  [[3.8, 49.1], [4.1, 49.22], [4.25, 49.0], [3.9, 48.95]], // Montagne de Reims
  [[5.25, 48.8], [5.55, 48.8], [5.7, 49.3], [5.4, 49.35]], // Meuse heights (Verdun, Les Eparges, St Mihiel)
  [[7.2, 50.8], [8.1, 50.8], [8.1, 51.35], [7.5, 51.25]], // Bergisches Land and Sauerland
];
const HILL_SPOTS = [
  [2.77, 50.4, 12], // Vimy ridge and Notre-Dame-de-Lorette
  [2.95, 50.82, 16], // Messines-Passchendaele ridge and the Ypres salient
  [2.55, 50.8, 9], // Monts de Flandre
  [2.82, 50.1, 10], // Albert and the Somme uplands
  [6.2, 48.78, 12], // Grand Couronne de Nancy
];
const FORESTS = [
  [[4.6, 49.9], [4.9, 50.25], [5.3, 50.35], [5.6, 50.5], [6.1, 50.55], [6.2, 50.2], [6.1, 49.9], [5.8, 49.62],
    [5.2, 49.55], [4.7, 49.65]], // Ardennes
  [[7.3, 49.15], [8.1, 49.15], [8.1, 49.5], [7.5, 49.4]], // Palatinate forest and the northern Vosges
  [[4.75, 48.95], [5.0, 48.95], [5.3, 49.4], [5.15, 49.5], [4.8, 49.3]], // Argonne
  [[4.8, 51.1], [5.5, 51.1], [5.6, 51.35], [5.0, 51.4]], // Kempen heath and pine woods
];
const FOREST_SPOTS = [
  [3.1, 49.3, 18], // Forests of Compiegne, Retz and Saint-Gobain
  [3.55, 50.2, 11], // Forest of Mormal
  [4.05, 49.95, 16], // Thierache
  [5.9, 48.7, 10], // Forest of Haye
  [4.4, 50.77, 8], // Foret de Soignes
  [1.85, 48.65, 12], // Rambouillet
  [2.65, 48.42, 12], // Fontainebleau
];
const MARSHES = [
  [[2.3, 50.85], [3.0, 50.95], [3.6, 51.2], [3.6, 51.4], [2.3, 51.2]], // Flemish polders and the Yser plain
  [[3.4, 51.4], [4.4, 51.5], [5.4, 51.8], [5.4, 52.0], [4.0, 52.0], [3.4, 51.7]], // Zeeland and the Rhine-Maas delta
  [[5.7, 51.25], [6.1, 51.25], [6.1, 51.5], [5.7, 51.5]], // De Peel
  [[5.5, 49.05], [5.9, 49.05], [5.9, 49.4], [5.6, 49.4]], // Woevre
];

// ---------------------------------------------------------------- rivers (a hex they run through gets the modifier)
const RIVERS = [
  { name: 'Rhine', big: true, line: [[7.75, 48.4], [7.8, 48.6], [8.1, 48.8]] },
  { name: 'Rhine', big: true, line: [[7.6, 50.36], [7.1, 50.73], [6.96, 50.94], [6.77, 51.23], [6.75, 51.45], [6.62, 51.65], [6.2, 51.83], [5.85, 51.85], [5.43, 51.88], [4.98, 51.83], [4.48, 51.92], [4.1, 51.98]] },
  { name: 'Meuse', line: [[5.68, 48.4], [5.55, 48.75], [5.54, 48.89], [5.38, 49.16], [5.19, 49.49], [4.94, 49.7], [4.72, 49.77], [4.83, 50.14], [4.91, 50.26], [4.87, 50.45]] },
  { name: 'Meuse', big: true, line: [[4.87, 50.45], [5.23, 50.52], [5.57, 50.63], [5.69, 50.85], [5.99, 51.19], [6.17, 51.37], [6.1, 51.55], [5.97, 51.72], [5.74, 51.76], [5.3, 51.72], [5.13, 51.73], [4.98, 51.83]] },
  { name: 'Moselle', line: [[6.3, 48.4], [6.1, 48.45], [5.95, 48.6], [5.89, 48.67], [5.95, 48.8], [6.05, 48.9], [6.15, 49.1], [6.17, 49.36], [6.37, 49.47], [6.64, 49.75], [7.07, 49.92], [7.35, 50.15], [7.6, 50.36]] },
  { name: 'Saar', line: [[7.1, 49.1], [6.95, 49.23], [6.75, 49.4], [6.55, 49.55], [6.55, 49.7]] },
  { name: 'Seine', line: [[2.95, 48.4], [2.66, 48.54], [2.48, 48.6], [2.35, 48.8], [2.15, 48.95], [2.05, 48.93], [1.7, 49.0], [1.48, 49.09], [1.4, 49.24], [1.0, 49.4]] },
  { name: 'Marne', line: [[4.95, 48.64], [4.58, 48.72], [4.36, 48.95], [3.95, 49.04], [3.4, 49.04], [2.88, 48.96], [2.6, 48.87], [2.42, 48.82]] },
  { name: 'Aisne', line: [[5.0, 49.15], [4.7, 49.4], [4.37, 49.5], [3.9, 49.43], [3.6, 49.4], [3.32, 49.38], [3.0, 49.4], [2.83, 49.42]] },
  { name: 'Oise', line: [[4.1, 49.95], [3.63, 49.9], [3.4, 49.75], [3.3, 49.65], [3.0, 49.58], [2.83, 49.42], [2.5, 49.25], [2.2, 49.07], [2.1, 49.0]] },
  { name: 'Somme', line: [[3.3, 49.85], [2.93, 49.93], [2.6, 49.92], [2.3, 49.9], [1.85, 50.1], [1.6, 50.2]] },
  { name: 'Scheldt', line: [[3.24, 50.17], [3.52, 50.36], [3.39, 50.6], [3.6, 50.85], [3.72, 51.05], [4.1, 51.03], [4.4, 51.22]] },
  { name: 'Scheldt', big: true, line: [[4.4, 51.22], [4.25, 51.37], [3.9, 51.4], [3.5, 51.4]] },
  { name: 'Lys', line: [[2.4, 50.64], [2.64, 50.64], [2.88, 50.69], [3.12, 50.8], [3.27, 50.83], [3.52, 50.98], [3.72, 51.05]] },
  { name: 'Yser', line: [[2.35, 50.83], [2.6, 50.95], [2.85, 51.03], [2.75, 51.13]] },
  { name: 'Sambre', line: [[3.65, 50.1], [3.97, 50.28], [4.2, 50.33], [4.44, 50.41], [4.87, 50.47]] },
  { name: 'Ruhr', line: [[8.0, 51.38], [7.6, 51.44], [7.35, 51.42], [7.0, 51.4], [6.88, 51.43], [6.73, 51.45]] },
  { name: 'Lippe', line: [[8.0, 51.7], [7.6, 51.65], [7.2, 51.62], [6.9, 51.65], [6.62, 51.65]] },
  { name: 'Sieg', line: [[8.0, 50.8], [7.6, 50.8], [7.2, 50.78], [7.1, 50.77]] },
  { name: 'Lahn', line: [[8.0, 50.4], [7.8, 50.35], [7.6, 50.36]] },
];

// ---------------------------------------------------------------- cities: [name, lon, lat, modifiers]
const PLACES = [
  ['Paris', 2.35, 48.85, ['bigcity']], ['Cologne', 6.96, 50.94, ['bigcity']], ['Essen', 7.01, 51.46, ['bigcity']],
  ['Brussels', 4.35, 50.85, ['bigcity']], ['Amsterdam', 4.9, 52.37, ['bigcity']],
  ['Antwerp', 4.4, 51.22, ['fortress', 'city']], ['Liege', 5.57, 50.63, ['fortress']], ['Namur', 4.87, 50.47, ['fortress']],
  ['Maubeuge', 3.97, 50.28, ['fortress']], ['Verdun', 5.38, 49.16, ['fortress']], ['Metz', 6.17, 49.12, ['fortress']],
  ['Thionville', 6.17, 49.36, ['fortress']], ['Toul', 5.89, 48.67, ['fortress']], ['Strasbourg', 7.75, 48.58, ['fortress']],
  ['Lille', 3.06, 50.63, ['city']], ['Amiens', 2.3, 49.9, ['city']], ['Reims', 4.03, 49.26, ['city']],
  ['Arras', 2.78, 50.29, ['city']], ['Sedan', 4.94, 49.7, ['city']], ['Luxembourg', 6.13, 49.61, ['city']],
  ['Nancy', 6.18, 48.69, ['city']], ['Aachen', 6.08, 50.78, ['city']], ['Dunkirk', 2.37, 51.04, ['city']],
  ['Charleroi', 4.44, 50.41, ['city']], ['Ghent', 3.72, 51.05, ['city']], ['Mons', 3.95, 50.45, ['city']],
  ['Cambrai', 3.24, 50.17, ['city']], ['Ypres', 2.88, 50.85, []], ['Noyon', 2.99, 49.58, []],
];
const CAPITALS = { A: 'Paris', B: 'Essen' };

// ================================================================ build
const key = (col, row) => `${col},${row}`;
const allHexes = [];
for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) allHexes.push({ col, row });

const nearestHex = (lon, lat) =>
  allHexes
    .map((h) => {
      const p = lonLat(h.col, h.row);
      return { ...h, d: Math.hypot((p.lon - lon) * KM_PER_LON, (p.lat - lat) * KM_PER_LAT) };
    })
    .sort((a, b) => a.d - b.d)[0];

const sea = new Set();
const country = {}; // hex key -> country code
for (const { col, row } of allHexes) {
  const p = lonLat(col, row);
  if (inPolygon(p, SEA)) {
    sea.add(key(col, row));
    continue;
  }
  const code = Object.keys(COUNTRIES).find((c) => inPolygon(p, COUNTRIES[c].polygon));
  if (!code) throw new Error(`hex ${key(col, row)} (${p.lon.toFixed(2)}, ${p.lat.toFixed(2)}) is in no country`);
  country[key(col, row)] = code;
}

// Terrain modifiers per hex, kept in this order: ground, river, city.
const ground = {};
for (const { col, row } of allHexes) {
  const k = key(col, row);
  if (sea.has(k)) continue;
  const p = lonLat(col, row);
  if (MOUNTAINS.some((poly) => inPolygon(p, poly))) ground[k] = 'mountain';
  else if (HILLS.some((poly) => inPolygon(p, poly)) || HILL_SPOTS.some((c) => inCircle(p, c))) ground[k] = 'hills';
  else if (FORESTS.some((poly) => inPolygon(p, poly)) || FOREST_SPOTS.some((c) => inCircle(p, c))) ground[k] = 'forest';
  else if (MARSHES.some((poly) => inPolygon(p, poly))) ground[k] = 'marsh';
}

// A river marks every hex it spends a few kilometres in, so the rivers form unbroken lines of hexes.
const riverOf = {};
for (const { big, line } of RIVERS) {
  const counts = {};
  const uv = line.map(toUV);
  for (let i = 1; i < uv.length; i++) {
    const [u0, v0] = uv[i - 1];
    const [u1, v1] = uv[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / 0.1));
    for (let s = 0; s <= steps; s++) {
      const h = hexAt([u0 + ((u1 - u0) * s) / steps, v0 + ((v1 - v0) * s) / steps]);
      const k = key(h.col, h.row);
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  for (const [k, n] of Object.entries(counts)) {
    const [col, row] = k.split(',').map(Number);
    if (n < 3 || col < 0 || row < 0 || col >= COLS || row >= ROWS || sea.has(k)) continue;
    riverOf[k] = big || riverOf[k] === 'bigriver' ? 'bigriver' : 'river';
  }
}

const cityOf = {};
const places = [];
for (const [name, lon, lat, mods] of PLACES) {
  const h = nearestHex(lon, lat);
  const k = key(h.col, h.row);
  if (sea.has(k)) continue;
  cityOf[k] = [...new Set([...(cityOf[k] ?? []), ...mods])];
  if (cityOf[k].includes('bigcity')) cityOf[k] = cityOf[k].filter((m) => m !== 'city');
  places.push({ name, col: h.col, row: h.row });
}

const terrain = {};
for (const { col, row } of allHexes) {
  const k = key(col, row);
  if (sea.has(k)) terrain[k] = 'sea';
  else {
    const mods = [ground[k], riverOf[k], ...(cityOf[k] ?? [])].filter(Boolean);
    if (mods.length) terrain[k] = mods.join('+');
  }
}

const countries = [];
for (let row = 0; row < ROWS; row++) {
  countries.push(allHexes.filter((h) => h.row === row).map((h) => country[key(h.col, h.row)] ?? '~').join(''));
}

const capitals = Object.fromEntries(
  Object.entries(CAPITALS).map(([owner, name]) => {
    const p = places.find((q) => q.name === name);
    return [owner, { col: p.col, row: p.row }];
  }),
);

// ---------------------------------------------------------------- armies on the Franco-German border
// A (France) stands on its border hexes; B (Germany) stands one hex further back, so an empty hex of
// no man's land lies between them. Neutral countries stay empty.
const isLand = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS && !sea.has(key(c, r));
const holds = (code) => (c, r) => isLand(c, r) && country[key(c, r)] === code;
const isFrench = holds('F');
const isGerman = holds('G');
const touches = (h, pred) => neighbors(h.col, h.row).some((n) => pred(n.col, n.row));
const aLine = allHexes.filter((h) => isFrench(h.col, h.row) && touches(h, isGerman));
const bFront = allHexes.filter((h) => isGerman(h.col, h.row) && touches(h, isFrench));
const inBFront = (c, r) => bFront.some((h) => h.col === c && h.row === r);
const bLine = allHexes.filter((h) => isGerman(h.col, h.row) && !inBFront(h.col, h.row) && touches(h, inBFront));

// Orders hexes into a path along the border, from the north end, always stepping to the nearest hex.
function walk(hexes) {
  const left = [...hexes].sort((p, q) => p.row - q.row || p.col - q.col);
  const path = [left.shift()];
  while (left.length) {
    const last = path.at(-1);
    let best = 0;
    left.forEach((h, i) => {
      if (distance(h, last) < distance(left[best], last)) best = i;
    });
    path.push(left.splice(best, 1)[0]);
  }
  return path;
}
const STEP = 2;
const spaced = (hexes) => {
  const path = walk(hexes);
  const picked = path.filter((_, i) => i % STEP === 0);
  if (path.length % STEP !== 1) picked.push(path.at(-1));
  return picked;
};
const aStacks = spaced(aLine);
const bStacks = spaced(bLine);
// Equal armies: the shorter side digs in an extra stack on its own line, as far from its other stacks as possible.
for (const [line, mine, theirs] of [[aLine, aStacks, bStacks], [bLine, bStacks, aStacks]]) {
  while (mine.length < Math.max(aStacks.length, bStacks.length)) {
    const gap = (h) => Math.min(...mine.map((s) => distance(s, h)));
    const free = line.filter((h) => !mine.some((s) => distance(s, h) === 0) && theirs.every((s) => distance(s, h) >= 2));
    mine.push(free.sort((p, q) => gap(q) - gap(p))[0]);
  }
}
const stacks = [
  ...aStacks.map((s) => ({ owner: 'A', col: s.col, row: s.row, men: 5 })),
  ...bStacks.map((s) => ({ owner: 'B', col: s.col, row: s.row, men: 5 })),
];

// Trench chips where the armies stand; the capitals are dug in deeper.
const defense = {};
for (const s of stacks) defense[key(s.col, s.row)] = 1;
for (const hex of Object.values(capitals)) defense[key(hex.col, hex.row)] = 2;

// ---------------------------------------------------------------- output
const sortKeys = (obj) =>
  Object.entries(obj).sort(([a], [b]) => {
    const [ac, ar] = a.split(',').map(Number);
    const [bc, br] = b.split(',').map(Number);
    return ar - br || ac - bc;
  });
const entries = (obj, per) => {
  const sorted = sortKeys(obj);
  const lines = [];
  for (let i = 0; i < sorted.length; i += per) {
    lines.push('    ' + sorted.slice(i, i + per).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', '));
  }
  return `{\n${lines.join(',\n')}\n  }`;
};
const list = (items) => `[\n${items.map((item) => '    ' + JSON.stringify(item)).join(',\n')}\n  ]`;
const borders = BORDER_LINES.map(([a, b, chain]) => ({ between: [a, b], line: chain.map(toUV).map(round) }));
const rivers = RIVERS.map(({ name, big, line }) => ({ name, big: Boolean(big), line: line.map(toUV).map(round) }));
const countryLabels = Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name, at: round(toUV(c.label)) }));
const countryNames = Object.fromEntries(Object.entries(COUNTRIES).map(([code, c]) => [code, c.name]));

writeFileSync(
  new URL('../data/map.json', import.meta.url),
  `{
  "name": "Western Front, Paris to the Ruhr",
  "hexKm": ${HEX_KM},
  "cols": ${COLS},
  "rows": ${ROWS},
  "countries": ${list(countries)},
  "owners": ${JSON.stringify(OWNERS)},
  "countryNames": ${JSON.stringify(countryNames)},
  "terrain": ${entries(terrain, 5)},
  "defense": ${entries(defense, 8)},
  "capitals": ${JSON.stringify(capitals)},
  "places": ${list(places)},
  "countryLabels": ${list(countryLabels)},
  "borders": ${list(borders)},
  "rivers": ${list(rivers)},
  "stacks": ${list(stacks)}
}
`,
);

// ASCII preview: ~ sea, lowercase letters = country, M mountain, H hills, T forest, w marsh, r river,
// R big river, C city, X fortress, @/# stacks of A/B, $ capitals.
if (process.argv.includes('--ascii')) {
  for (let row = 0; row < ROWS; row++) {
    let line = row % 2 ? '  ' : '';
    for (let col = 0; col < COLS; col++) {
      const k = key(col, row);
      const t = terrain[k] ?? '';
      const stack = stacks.find((s) => s.col === col && s.row === row);
      const cap = Object.values(capitals).some((c) => c.col === col && c.row === row);
      let ch = sea.has(k) ? '~' : country[k].toLowerCase();
      if (t.includes('mountain')) ch = 'M';
      else if (t.includes('hills')) ch = 'H';
      else if (t.includes('forest')) ch = 'T';
      else if (t.includes('marsh')) ch = 'w';
      if (t.includes('bigriver')) ch = 'R';
      else if (t.includes('river')) ch = 'r';
      if (t.includes('city') || t.includes('fortress')) ch = t.includes('fortress') ? 'X' : 'C';
      if (stack) ch = stack.owner === 'A' ? '@' : '#';
      if (cap) ch = '$';
      line += ch + '  ';
    }
    console.log(String(row).padStart(2), line);
  }
  console.log(`${aStacks.length} stacks per side`);
  console.log(Object.entries(terrain).filter(([, v]) => v.split('+').length >= 3).map(([k, v]) => `${k}: ${v}`).join('\n'));
}
