// A larva's portrait: a deterministic drawing from its genome hash and
// generation, in the site's palette. Nothing here claims to be a photograph
// of anything — it is the record's picture of the record.

const PAPER = "#F3EEE3";
const INK = "#141311";
const YEAST = "#E9E2C9";
const AMBER = "#C98A2B";

export type Portrait = { id: number; genomeHash: string; generation: number; status: string };

/// splitmix64 over the genome hash so every stroke is a pure function of it
function rng(seed: bigint) {
  let s = BigInt.asUintN(64, seed);
  return () => {
    s = BigInt.asUintN(64, s + 0x9e3779b97f4a7c15n);
    let z = s;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    z ^= z >> 31n;
    return Number(z & 0xffffffn) / 0x1000000; // [0,1)
  };
}

export function larvaSvg(p: Portrait): string {
  const seed = BigInt("0x" + (p.genomeHash.replace(/^0x/, "").slice(0, 16) || "0"));
  const r = rng(seed ^ BigInt(p.generation));
  const W = 400, H = 400;
  const NSEG = 11;
  // A body curve: a gentle S, its amplitude and phase from the hash.
  const amp = 14 + r() * 26;
  const phase = r() * Math.PI * 2;
  const bendFreq = 1.2 + r() * 1.4;
  const x0 = 60, x1 = 340;
  const pts: { x: number; y: number; w: number }[] = [];
  for (let i = 0; i <= NSEG; i++) {
    const t = i / NSEG;
    const x = x0 + (x1 - x0) * t;
    const y = 200 + Math.sin(t * bendFreq * Math.PI + phase) * amp;
    // first instar: widest through the mid-abdomen, tapering to the tail
    const w = 9 + 12 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.35);
    pts.push({ x, y, w });
  }
  let outline = "";
  const top: string[] = [], bot: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
    const dx = p1.x - p0.x, dy = p1.y - p0.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    top.push(`${(pts[i].x + nx * pts[i].w).toFixed(1)},${(pts[i].y + ny * pts[i].w).toFixed(1)}`);
    bot.push(`${(pts[i].x - nx * pts[i].w).toFixed(1)},${(pts[i].y - ny * pts[i].w).toFixed(1)}`);
  }
  outline = `M${top.join(" L")} L${bot.reverse().join(" L")} Z`;

  // Segment boundaries: hairline rings along the body.
  let rings = "";
  for (let i = 1; i < NSEG; i++) {
    const p0 = pts[i - 1], p1 = pts[i + 1], c = pts[i];
    const dx = p1.x - p0.x, dy = p1.y - p0.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    rings += `<line x1="${(c.x + nx * c.w).toFixed(1)}" y1="${(c.y + ny * c.w).toFixed(1)}" ` +
      `x2="${(c.x - nx * c.w).toFixed(1)}" y2="${(c.y - ny * c.w).toFixed(1)}" stroke="${INK}" stroke-opacity="0.35" stroke-width="0.6"/>`;
  }
  // The gut: a darker amber band through the middle segments, its extent
  // from the hash.
  const gutFrom = 2 + Math.floor(r() * 2), gutTo = 7 + Math.floor(r() * 2);
  const gut = pts.slice(gutFrom, gutTo + 1).map(q => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" L");
  // Mouth hooks: two dark strokes at the head (the left end).
  const head = pts[0];
  const hooks = `<path d="M${(head.x - 2).toFixed(1)},${(head.y - 3).toFixed(1)} l-9,-5 M${(head.x - 2).toFixed(1)},${(head.y + 3).toFixed(1)} l-9,5" stroke="${INK}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`;
  // Posterior spiracles: two small marks at the tail.
  const tail = pts[NSEG];
  const spiracles = `<circle cx="${(tail.x + 1).toFixed(1)}" cy="${(tail.y - 3).toFixed(1)}" r="1.4" fill="${INK}"/>` +
    `<circle cx="${(tail.x + 1).toFixed(1)}" cy="${(tail.y + 3).toFixed(1)}" r="1.4" fill="${INK}"/>`;
  // Denticle belts: short ticks under each abdominal segment, their count a
  // function of the hash so no two portraits are alike.
  let denticles = "";
  for (let i = 3; i < NSEG; i++) {
    const n = 3 + Math.floor(r() * 4);
    const c = pts[i];
    for (let k = 0; k < n; k++) {
      const x = c.x - 8 + (16 * k) / Math.max(1, n - 1);
      denticles += `<line x1="${x.toFixed(1)}" y1="${(c.y + c.w - 2).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(c.y + c.w + 1).toFixed(1)}" stroke="${INK}" stroke-width="0.8"/>`;
    }
  }
  const short = p.genomeHash.replace(/^0x/, "").slice(0, 16);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${PAPER}"/>` +
    `<line x1="24" y1="40" x2="376" y2="40" stroke="${INK}" stroke-width="0.6"/>` +
    `<text x="24" y="30" fill="${INK}" font-family="'IBM Plex Mono', monospace" font-size="12">INSTAR  larva ${p.id}  gen ${p.generation}  ${p.status}</text>` +
    `<path d="${outline}" fill="${YEAST}" stroke="${INK}" stroke-width="1.2"/>` +
    `<path d="M${gut}" fill="none" stroke="${AMBER}" stroke-width="7" stroke-linecap="round" stroke-opacity="0.85"/>` +
    rings + denticles + hooks + spiracles +
    `<line x1="24" y1="360" x2="376" y2="360" stroke="${INK}" stroke-width="0.6"/>` +
    `<text x="24" y="380" fill="${INK}" font-family="'IBM Plex Mono', monospace" font-size="11">genome ${short}  D. melanogaster L1  Winding 2023</text>` +
    `</svg>`;
}
