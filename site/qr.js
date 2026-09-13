// QR code encoder: byte mode, error-correction level M, versions 1 to 10
// (up to 213 bytes). Written for the deposit address so the page never loads
// a QR library from a CDN. Follows ISO/IEC 18004; the mask is chosen by the
// standard four penalty rules.

const EC_M = [
  // [ecCodewordsPerBlock, [blockCount, dataCodewords]...] indexed by version
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function generatorPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsRemainder(data, ecLen) {
  const gen = generatorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor === 0) continue;
    for (let j = 0; j < ecLen; j++) rem[j] ^= gmul(gen[j + 1], factor);
  }
  return rem;
}

function dataCapacity(version) {
  const t = EC_M[version];
  let cw = 0;
  for (let i = 1; i < t.length; i++) cw += t[i][0] * t[i][1];
  // mode (4) + count (8 or 16) bits, then whole bytes
  return cw - (version >= 10 ? 3 : 2);
}

// (value << degree) | BCH remainder
function bch(value, poly, degree) {
  let x = value << degree;
  for (let bit = 31; bit >= degree; bit--) {
    if (x & (1 << bit)) x ^= poly << (bit - degree);
  }
  return (value << degree) | x;
}
// EC level M is 00, so the format data field is just the mask id
const formatBits = (mask) => bch(mask, 0x537, 10) ^ 0x5412;
const versionBits = (version) => bch(version, 0x1f25, 12);

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

export function encodeQR(text, forceMask = -1) {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 10 && dataCapacity(version) < bytes.length) version++;
  if (version > 10) throw new Error("qr: payload too long for version 10");
  const table = EC_M[version];
  const ecLen = table[0];
  let totalData = 0;
  for (let i = 1; i < table.length; i++) totalData += table[i][0] * table[i][1];

  // --- bit stream ---
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = new Uint8Array(totalData);
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data[i >> 3] = v;
  }
  for (let i = bits.length >> 3, k = 0; i < totalData; i++, k++) data[i] = k & 1 ? 0x11 : 0xec;

  // --- blocks + interleave ---
  const blocks = [];
  let off = 0;
  for (let i = 1; i < table.length; i++) {
    const [count, len] = table[i];
    for (let b = 0; b < count; b++) {
      const d = data.subarray(off, off + len);
      blocks.push({ d, e: rsRemainder(d, ecLen) });
      off += len;
    }
  }
  const out = [];
  const maxLen = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);

  // --- function patterns ---
  const size = version * 4 + 17;
  const m = new Uint8Array(size * size);
  const fixed = new Uint8Array(size * size);
  const set = (x, y, v) => { m[y * size + x] = v; fixed[y * size + x] = 1; };
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const r = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, r <= 1 || r === 3 ? 1 : 0);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = ALIGN[version];
  for (const ay of al) for (const ax of al) {
    if (fixed[ay * size + ax]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const r = Math.max(Math.abs(dx), Math.abs(dy));
      set(ax + dx, ay + dy, r !== 1 ? 1 : 0);
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (!fixed[6 * size + i]) set(i, 6, (i & 1) ^ 1);
    if (!fixed[i * size + 6]) set(6, i, (i & 1) ^ 1);
  }
  set(8, size - 8, 1);
  for (let i = 0; i < 8; i++) {
    fixed[8 * size + i] = 1; fixed[i * size + 8] = 1;
    fixed[8 * size + size - 1 - i] = 1; fixed[(size - 1 - i) * size + 8] = 1;
  }
  fixed[8 * size + 8] = 1;
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      fixed[i * size + size - 11 + j] = 1;
      fixed[(size - 11 + j) * size + i] = 1;
    }
  }

  // --- data placement: two-column zigzag, skipping the vertical timing column ---
  const dataBits = [];
  for (const b of out) for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1);
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y * size + x]) continue;
        m[y * size + x] = k < dataBits.length ? dataBits[k] : 0;
        k++;
      }
    }
  }

  const applyMask = (grid, mk) => {
    const fn = MASKS[mk];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!fixed[y * size + x] && fn(x, y)) grid[y * size + x] ^= 1;
    }
  };
  const writeFormat = (grid, mk) => {
    const f = formatBits(mk);
    for (let i = 0; i < 15; i++) {
      const bit = (f >> i) & 1;
      if (i < 6) grid[i * size + 8] = bit;
      else if (i < 8) grid[(i + 1) * size + 8] = bit;
      else if (i === 8) grid[8 * size + 7] = bit;
      else grid[8 * size + (14 - i)] = bit;
      if (i < 8) grid[8 * size + (size - 1 - i)] = bit;
      else grid[(size - 15 + i) * size + 8] = bit;
    }
    if (version >= 7) {
      const v = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (v >> i) & 1;
        const a = Math.floor(i / 3), b = size - 11 + (i % 3);
        grid[a * size + b] = bit;
        grid[b * size + a] = bit;
      }
    }
  };
  const penalty = (grid) => {
    let score = 0;
    const at = (x, y) => grid[y * size + x];
    for (let pass = 0; pass < 2; pass++) {
      const g = pass ? (a, b) => at(a, b) : (a, b) => at(b, a);
      for (let a = 0; a < size; a++) {
        let run = 0, prev = -1;
        for (let b = 0; b < size; b++) {
          const v = g(a, b);
          if (v === prev) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
          else { prev = v; run = 1; }
        }
        // finder-like 1011101 with four light modules on either side
        for (let b = 0; b + 7 <= size; b++) {
          if (!(g(a, b) && !g(a, b + 1) && g(a, b + 2) && g(a, b + 3) && g(a, b + 4) && !g(a, b + 5) && g(a, b + 6))) continue;
          let before = b >= 4, after = b + 10 < size;
          for (let i = 1; i <= 4 && before; i++) if (g(a, b - i)) before = false;
          for (let i = 7; i <= 10 && after; i++) if (g(a, b + i)) after = false;
          if (before) score += 40;
          if (after) score += 40;
        }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
    let dark = 0;
    for (let i = 0; i < grid.length; i++) dark += grid[i];
    score += (Math.ceil(Math.abs(dark * 20 - grid.length * 10) / grid.length) - 1) * 10;
    return score;
  };
  let best = null, bestScore = Infinity, bestMask = -1;
  for (let mk = 0; mk < 8; mk++) {
    if (forceMask >= 0 && mk !== forceMask) continue;
    const g = Uint8Array.from(m);
    applyMask(g, mk);
    writeFormat(g, mk);
    const s = penalty(g);
    if (s < bestScore) { bestScore = s; best = g; bestMask = mk; }
  }
  return { size, modules: best, version, mask: bestMask };
}

// Draw onto a canvas as crisp ink squares on the page's paper colour.
export function drawQR(canvas, text, { scale = 4, quiet = 4, ink = "#141311", paper = "#F3EEE3" } = {}) {
  const { size, modules } = encodeQR(text);
  const px = (size + quiet * 2) * scale;
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = ink;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (modules[y * size + x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  }
  return { size };
}
