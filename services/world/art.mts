// A larva's portrait: an entomological plate of a first-instar larva, drawn
// deterministically from the genome hash and the generation. Dorsal view,
// pen outline, stippled gut, the two dorsal tracheal trunks, segment folds,
// and two detail insets (the cephalopharyngeal skeleton and a posterior
// spiracle with its two slits, which is how a first instar is told apart).
// It is the record's picture of the record, not a photograph of anything.

const PAPER = "#F3EEE3";
const INK = "#141311";
const INK2 = "#5A5650";
const CUTICLE = "#EFE9D9";
const GUT = "#8A5A2B";
const RULE = "#B9B2A3";
const SERIF = "'Fraunces', 'Iowan Old Style', Georgia, 'Times New Roman', serif";
const MONO = "'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

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

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Sample = { x: number; y: number; tx: number; ty: number; nx: number; ny: number; r: number; u: number };

export function larvaSvg(p: Portrait): string {
  const hex = p.genomeHash.replace(/^0x/, "").replace(/[^0-9a-fA-F]/g, "");
  // fold the whole hash into the seed: founders' hashes begin with zeros
  let seed = 0n;
  for (let i = 0; i < hex.length; i += 16) seed ^= BigInt("0x" + hex.slice(i, i + 16));
  const r = rng(seed ^ BigInt(p.generation));
  const W = 1000, H = 1000;
  const NSEG = 11;

  // ---- the body: a spine curve sampled finely, a radius profile with a
  // smooth pinch at every segment boundary
  const amp = 22 + r() * 40;
  const phase = r() * Math.PI * 2;
  const freq = 1.1 + r() * 1.2;
  const tilt = (r() - 0.5) * 0.5;          // the whole animal lies a little askew
  const fat = 0.9 + r() * 0.25;
  const headScale = 0.78 + r() * 0.12;
  const tailTaper = 0.5 + r() * 0.25;
  const LEN = 620;
  const RMAX = 52 * fat;
  const N = 132;
  const cx = 500, cy = 470;
  const spine: Sample[] = [];
  const pt = (u: number) => {
    const x = (u - 0.5) * LEN;
    const y = Math.sin(u * freq * Math.PI + phase) * amp + Math.sin(u * 0.5 * Math.PI + phase * 0.7) * amp * 0.35;
    return { x: cx + x * Math.cos(tilt) - y * Math.sin(tilt), y: cy + x * Math.sin(tilt) + y * Math.cos(tilt) };
  };
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const a = pt(Math.max(0, u - 0.004)), b = pt(Math.min(1, u + 0.004)), c = pt(u);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    // fusiform: a blunt pseudocephalon, the widest through the mid-abdomen,
    // a tapering tail; each boundary pinched by a raised cosine
    let rad = 0.4 + 0.6 * Math.sin(Math.PI * Math.min(1, 0.05 + u * 0.98));
    if (u < 0.09) rad *= headScale + (1 - headScale) * (u / 0.09);
    if (u > 0.82) rad *= 1 - tailTaper * ((u - 0.82) / 0.18) ** 1.6;
    const seg = u * NSEG;
    const pinch = 1 - 0.05 * (1 + Math.cos(2 * Math.PI * (seg % 1)));
    if (u > 0.02 && u < 0.98) rad *= pinch;
    spine.push({ x: c.x, y: c.y, tx: dx / len, ty: dy / len, nx: -dy / len, ny: dx / len, r: rad * RMAX, u });
  }
  const at = (u: number) => spine[Math.max(0, Math.min(N, Math.round(u * N)))];
  const edge = (s: Sample, side: number, k = 1) => ({ x: s.x + s.nx * s.r * side * k, y: s.y + s.ny * s.r * side * k });
  const top: string[] = [], bot: string[] = [];
  for (const s of spine) {
    const a = edge(s, 1), b = edge(s, -1);
    top.push(`${f1(a.x)},${f1(a.y)}`);
    bot.push(`${f1(b.x)},${f1(b.y)}`);
  }
  const head = spine[0], tail = spine[N];
  const outline = `M${top.join(" L")} Q${f1(tail.x + tail.tx * tail.r * 0.9)},${f1(tail.y + tail.ty * tail.r * 0.9)} ${bot[bot.length - 1]} L${bot.slice().reverse().slice(1).join(" L")} Q${f1(head.x - head.tx * head.r * 1.05)},${f1(head.y - head.ty * head.r * 1.05)} ${top[0]} Z`;

  // ---- segment folds: a fold line at every boundary, bowed toward the head
  let folds = "";
  for (let k = 1; k < NSEG; k++) {
    const s = at(k / NSEG);
    const a = edge(s, 1), b = edge(s, -1);
    const bow = s.r * 0.22;
    folds += `<path d="M${f1(a.x)},${f1(a.y)} Q${f1(s.x - s.tx * bow)},${f1(s.y - s.ty * bow)} ${f1(b.x)},${f1(b.y)}" stroke="${INK}" stroke-opacity="0.55" stroke-width="1.1" fill="none"/>`;
    // the fold's shadow: a soft hatch just behind it
    folds += `<path d="M${f1(a.x + s.tx * 2)},${f1(a.y + s.ty * 2)} Q${f1(s.x - s.tx * (bow - 2))},${f1(s.y - s.ty * (bow - 2))} ${f1(b.x + s.tx * 2)},${f1(b.y + s.ty * 2)}" stroke="${INK}" stroke-opacity="0.12" stroke-width="3" fill="none"/>`;
  }

  // ---- the gut: a darker band through the midline, its extent and fill
  // from the hash; stippled, denser toward the middle
  const gutFrom = 0.13 + r() * 0.05, gutTo = 0.86 + r() * 0.06;
  const gutFill = 0.45 + r() * 0.45;
  const gutW = 0.3 + 0.16 * gutFill;
  const gTop: string[] = [], gBot: string[] = [];
  for (const s of spine) {
    if (s.u < gutFrom || s.u > gutTo) continue;
    const w = gutW * (0.6 + 0.4 * Math.sin(Math.PI * (s.u - gutFrom) / (gutTo - gutFrom)));
    const wob = 1 + 0.08 * Math.sin(s.u * 71 + phase);
    const a = edge(s, 1, w * wob), b = edge(s, -1, w / wob);
    gTop.push(`${f1(a.x)},${f1(a.y)}`); gBot.push(`${f1(b.x)},${f1(b.y)}`);
  }
  const gutPath = `M${gTop.join(" L")} L${gBot.reverse().join(" L")} Z`;
  let stipple = "";
  const dots = 900 + Math.floor(gutFill * 900);
  for (let i = 0; i < dots; i++) {
    const u = gutFrom + (gutTo - gutFrom) * r();
    const s = at(u);
    const w = gutW * (0.6 + 0.4 * Math.sin(Math.PI * (u - gutFrom) / (gutTo - gutFrom)));
    // pile the dots toward the middle of the band
    const q = (r() + r() - 1) * w * 0.95;
    const j = (r() - 0.5) * (LEN / N);
    const x = s.x + s.nx * s.r * q + s.tx * j, y = s.y + s.ny * s.r * q + s.ty * j;
    stipple += `M${f1(x)},${f1(y)}h.01`;
  }
  // body shading: stipple along the flanks, sparse at the crest
  let flank = "";
  for (let i = 0; i < 1600; i++) {
    const u = 0.02 + 0.96 * r();
    const s = at(u);
    const side = r() < 0.5 ? -1 : 1;
    const q = 0.9 - Math.pow(r(), 1.6) * 0.55; // pile toward the flank, inside the line
    const j = (r() - 0.5) * (LEN / N);
    const x = s.x + s.nx * s.r * q * side + s.tx * j, y = s.y + s.ny * s.r * q * side + s.ty * j;
    flank += `M${f1(x)},${f1(y)}h.01`;
  }

  // ---- tracheal trunks: two dorsal lines from the tail spiracles forward,
  // fading toward the head
  let trachea = "";
  for (const side of [-1, 1]) {
    const pts: string[] = [];
    for (const s of spine) {
      if (s.u < 0.06 || s.u > 0.985) continue;
      const wob = 0.36 + 0.03 * Math.sin(s.u * 40 + phase + side);
      const e = edge(s, side, wob);
      pts.push(`${f1(e.x)},${f1(e.y)}`);
    }
    trachea += `<path d="M${pts.join(" L")}" stroke="${INK}" stroke-opacity="0.5" stroke-width="1.3" fill="none"/>`;
    trachea += `<path d="M${pts.join(" L")}" stroke="${PAPER}" stroke-opacity="0.6" stroke-width="0.5" fill="none" transform="translate(0.6,0.6)"/>`;
  }

  // ---- mouth hooks: the dark cephalopharyngeal skeleton showing through the
  // pseudocephalon; two hooks ahead of it
  const hookCurl = 0.6 + r() * 0.5;
  const hx = head.x - head.tx * head.r * 0.4, hy = head.y - head.ty * head.r * 0.4;
  const hookPath = (side: number) => {
    const bx = hx + head.nx * side * head.r * 0.22, by = hy + head.ny * side * head.r * 0.22;
    const tx = bx - head.tx * head.r * 0.95 + head.nx * side * head.r * 0.1 * hookCurl;
    const ty = by - head.ty * head.r * 0.95 + head.ny * side * head.r * 0.1 * hookCurl;
    const c1x = bx - head.tx * head.r * 0.5 - head.nx * side * head.r * 0.12 * hookCurl;
    const c1y = by - head.ty * head.r * 0.5 - head.ny * side * head.r * 0.12 * hookCurl;
    return `M${f1(bx)},${f1(by)} Q${f1(c1x)},${f1(c1y)} ${f1(tx)},${f1(ty)}`;
  };
  const hooks = `<path d="${hookPath(1)} ${hookPath(-1)}" stroke="${INK}" stroke-width="3.2" stroke-linecap="round" fill="none"/>` +
    // the skeleton's body: a dark wedge inside the first segments
    `<path d="M${f1(hx)},${f1(hy)} l${f1(head.tx * head.r * 1.4 + head.nx * head.r * 0.3)},${f1(head.ty * head.r * 1.4 + head.ny * head.r * 0.3)} l${f1(-head.nx * head.r * 0.6)},${f1(-head.ny * head.r * 0.6)} Z" fill="${INK}" fill-opacity="0.35"/>`;

  // ---- posterior spiracles: two short stalks at the tail, each with two slits
  const spiracleAt = (s: Sample, side: number, scale: number) => {
    const bx = s.x + s.nx * side * s.r * 0.55, by = s.y + s.ny * side * s.r * 0.55;
    const ex = bx + s.tx * 6 * scale, ey = by + s.ty * 6 * scale;
    return `<path d="M${f1(bx)},${f1(by)} L${f1(ex)},${f1(ey)}" stroke="${INK}" stroke-width="${f1(3.4 * scale)}" stroke-linecap="round"/>` +
      `<circle cx="${f1(ex)}" cy="${f1(ey)}" r="${f1(3.2 * scale)}" fill="${INK}"/>`;
  };
  const spiracles = spiracleAt(at(0.975), 1, 1) + spiracleAt(at(0.975), -1, 1);

  // ---- cast shadow: hatch lines under the body, offset to the lower right
  let shadow = "";
  for (let i = 0; i <= N; i += 3) {
    const s = spine[i];
    const a = edge(s, 1, 0.9), b = edge(s, -1, 0.9);
    shadow += `M${f1(a.x + 9)},${f1(a.y + 12)} L${f1(b.x + 9)},${f1(b.y + 12)}`;
  }

  // ---- insets: (a) the cephalopharyngeal skeleton, (b) a posterior spiracle
  const inset = (x: number, y: number, label: string, body: string) =>
    `<g><circle cx="${x}" cy="${y}" r="96" fill="${PAPER}" stroke="${INK}" stroke-width="0.8"/>` +
    `<clipPath id="c${label}"><circle cx="${x}" cy="${y}" r="95"/></clipPath><g clip-path="url(#c${label})">${body}</g>` +
    `<text x="${x - 96}" y="${y + 122}" fill="${INK}" font-family="${SERIF}" font-style="italic" font-size="15">${label}.</text></g>`;
  const skel = (x: number, y: number) => {
    const k = 1 + hookCurl * 0.3;
    return `<path d="M${x - 10},${y + 18} C${x - 60},${y + 10} ${x - 70},${y - 20 * k} ${x - 84},${y - 30 * k}` +
      ` M${x - 10},${y + 18} C${x - 60},${y + 26} ${x - 70},${y + 40 * k} ${x - 84},${y + 44 * k}" stroke="${INK}" stroke-width="7" stroke-linecap="round" fill="none"/>` +
      `<path d="M${x - 12},${y - 2} L${x + 62},${y - 34} L${x + 70},${y + 4} L${x + 58},${y + 40} L${x - 12},${y + 36} Z" fill="${INK}" fill-opacity="0.32" stroke="${INK}" stroke-width="1"/>` +
      `<path d="M${x + 4},${y - 6} L${x + 44},${y - 22} M${x + 6},${y + 30} L${x + 44},${y + 30}" stroke="${INK}" stroke-width="1.2"/>`;
  };
  const spir = (x: number, y: number) =>
    `<path d="M${x - 40},${y + 60} L${x - 10},${y - 10}" stroke="${INK}" stroke-width="16" stroke-linecap="round"/>` +
    `<circle cx="${x - 4}" cy="${y - 22}" r="26" fill="${CUTICLE}" stroke="${INK}" stroke-width="2"/>` +
    // two slits: the first-instar count
    `<path d="M${x - 16},${y - 32} L${x - 6},${y - 8} M${x + 2},${y - 36} L${x + 12},${y - 12}" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>` +
    `<path d="M${x - 42},${y + 62} L${x - 60},${y + 96} M${x - 40},${y + 60} L${x - 20},${y + 96}" stroke="${INK}" stroke-opacity="0.45" stroke-width="1"/>`;

  // ---- captions
  const short = hex.length > 16 ? `\u2026${hex.slice(-16)}` : hex || "0";
  const title = `Instar #${p.id} \u00b7 generation ${p.generation}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><filter id="grain" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${p.id % 97}"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.32  0 0 0 0 0.26  0 0 0 0.06 0"/></filter></defs>` +
    `<rect width="${W}" height="${H}" fill="${PAPER}"/>` +
    `<rect width="${W}" height="${H}" filter="url(#grain)"/>` +
    // plate frame
    `<rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="${INK}" stroke-width="1"/>` +
    `<rect x="46" y="46" width="${W - 92}" height="${H - 92}" fill="none" stroke="${INK}" stroke-width="0.4"/>` +
    // header
    `<text x="70" y="88" fill="${INK}" font-family="${MONO}" font-size="13" letter-spacing="3">INSTAR</text>` +
    `<text x="${W - 70}" y="88" text-anchor="end" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="17">Drosophila melanogaster, first instar, dorsal</text>` +
    `<line x1="70" y1="104" x2="${W - 70}" y2="104" stroke="${RULE}" stroke-width="0.8"/>` +
    // the animal
    `<path d="${shadow}" stroke="${INK}" stroke-opacity="0.16" stroke-width="1"/>` +
    `<path d="${outline}" fill="${CUTICLE}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<path d="${flank}" stroke="${INK}" stroke-opacity="0.5" stroke-width="1.4" stroke-linecap="round"/>` +
    `<path d="${gutPath}" fill="${GUT}" fill-opacity="${f1(0.25 + gutFill * 0.35)}"/>` +
    `<path d="${stipple}" stroke="#4A2E14" stroke-opacity="0.7" stroke-width="1.7" stroke-linecap="round"/>` +
    trachea + folds + hooks + spiracles +
    // the outline again over the shading so the edge stays crisp
    `<path d="${outline}" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>` +
    // labels with leader lines
    `<path d="M${f1(head.x - head.tx * head.r * 1.6)},${f1(head.y - head.ty * head.r * 1.6)} L150,${f1(head.y - 90)}" stroke="${INK2}" stroke-width="0.7" fill="none"/>` +
    `<text x="150" y="${f1(head.y - 96)}" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="15">mouth hooks</text>` +
    `<path d="M${f1(tail.x + tail.tx * 4)},${f1(tail.y + tail.ty * 4)} L${W - 150},${f1(tail.y + 90)}" stroke="${INK2}" stroke-width="0.7" fill="none"/>` +
    `<text x="${W - 150}" y="${f1(tail.y + 108)}" text-anchor="end" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="15">posterior spiracles</text>` +
    // insets
    inset(196, 760, "a", skel(196, 760)) + inset(W - 196, 760, "b", spir(W - 196, 760)) +
    // scale bar: nominal, a first instar is about a millimetre long
    `<path d="M${cx - 155},640 v6 M${cx - 155},643 h310 M${cx + 155},640 v6" stroke="${INK}" stroke-width="1" fill="none"/>` +
    `<text x="${cx}" y="662" text-anchor="middle" fill="${INK2}" font-family="${MONO}" font-size="11">0.5 mm, nominal</text>` +
    // caption
    `<line x1="70" y1="${H - 104}" x2="${W - 70}" y2="${H - 104}" stroke="${RULE}" stroke-width="0.8"/>` +
    `<text x="70" y="${H - 72}" fill="${INK}" font-family="${SERIF}" font-size="26">${esc(title)}</text>` +
    `<text x="70" y="${H - 50}" fill="${INK2}" font-family="${MONO}" font-size="11.5">genome ${esc(short)} \u00b7 ${esc(p.status)} \u00b7 a. cephalopharyngeal skeleton \u00b7 b. posterior spiracle, two slits</text>` +
    `<text x="${W - 70}" y="${H - 72}" text-anchor="end" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="15">after Winding et al. 2023</text>` +
    `</svg>`;
}
