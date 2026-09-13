// A fly's portrait: an entomological plate of an adult male Drosophila
// melanogaster, drawn deterministically from the genome hash and the
// generation. Dorsal view, pen outline, red compound eyes, the thorax with its
// bristle rows, the male abdomen with its fully dark posterior tergites, two
// wings with the six longitudinal veins and both crossveins, halteres, six
// legs, and two detail insets (the sex comb on the fore tarsus, which is how a
// male is told apart, and a patch of the compound eye's facets).
// It is the record's picture of the record, not a photograph of anything.

const PAPER = "#F3EEE3";
const INK = "#141311";
const INK2 = "#5A5650";
const CUTICLE = "#D9B07A";
const CUTICLE_DARK = "#7A5A33";
const TERGITE_DARK = "#2A2320";
const EYE = "#A5231F";
const EYE_DARK = "#5E1210";
const WING = "#FFFFFF";
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
const P = (x: number, y: number) => `${f1(x)},${f1(y)}`;

type Pt = { x: number; y: number };

/// A wing in its own frame: base at the origin, the long axis along +x in
/// units of wing length, +y toward the posterior margin. Every point is
/// mapped through `T` (rotate + mirror + translate), which keeps the Bezier
/// controls honest because the map is affine.
function wing(T: (x: number, y: number) => Pt, curl: number, r: () => number) {
  const c = (x: number, y: number) => { const p = T(x, y); return P(p.x, p.y); };
  // outline: costa nearly straight, a full posterior margin, the alula notch at the base
  const outline =
    `M${c(0, -0.01)} C${c(0.3, -0.05 - curl * 0.02)} ${c(0.7, -0.045)} ${c(1, 0.03)}` +
    ` C${c(0.97, 0.12)} ${c(0.8, 0.2)} ${c(0.55, 0.225)}` +
    ` C${c(0.38, 0.235)} ${c(0.25, 0.22)} ${c(0.16, 0.17)}` +
    ` C${c(0.13, 0.19)} ${c(0.09, 0.2)} ${c(0.06, 0.17)}` +
    ` C${c(0.03, 0.12)} ${c(0.01, 0.05)} ${c(0, -0.01)} Z`;
  // the six longitudinal veins and two crossveins of a Drosophila wing
  const j = (k: number) => (r() - 0.5) * 0.02 * k;
  const L1 = `M${c(0.02, 0)} C${c(0.15, -0.02)} ${c(0.28, -0.03)} ${c(0.36, -0.035 + j(1))}`;
  const L2 = `M${c(0.1, 0.01)} C${c(0.4, 0.0 + j(1))} ${c(0.62, -0.02)} ${c(0.76, -0.035)}`;
  const L3 = `M${c(0.1, 0.02)} C${c(0.45, 0.035 + j(1))} ${c(0.75, 0.03)} ${c(0.985, 0.025)}`;
  const L4 = `M${c(0.1, 0.035)} C${c(0.4, 0.075 + j(1))} ${c(0.7, 0.11)} ${c(0.9, 0.135)}`;
  const L5 = `M${c(0.08, 0.05)} C${c(0.3, 0.12 + j(1))} ${c(0.5, 0.17)} ${c(0.66, 0.21)}`;
  const L6 = `M${c(0.06, 0.07)} C${c(0.14, 0.13)} ${c(0.2, 0.17)} ${c(0.25, 0.22)}`;
  const acv = `M${c(0.4, 0.033 + j(0.5))} L${c(0.41, 0.076)}`;
  const pcv = `M${c(0.66, 0.104 + j(0.5))} L${c(0.6, 0.183)}`;
  return { outline, veins: [L1, L2, L3, L4, L5, L6, acv, pcv].join(" ") };
}

export function flySvg(p: Portrait): string {
  const hex = p.genomeHash.replace(/^0x/, "").replace(/[^0-9a-fA-F]/g, "");
  // fold the whole hash into the seed: founders' hashes begin with zeros
  let seed = 0n;
  for (let i = 0; i < hex.length; i += 16) seed ^= BigInt("0x" + hex.slice(i, i + 16));
  const r = rng(seed ^ BigInt(p.generation));
  const W = 1000, H = 1000;

  // ---- proportions from the hash: the whole animal lies a little askew
  const tilt = (r() - 0.5) * 8;                  // degrees
  const cx = 500, cy = 400;
  const thoraxW = 84 + r() * 14, thoraxL = 118 + r() * 10;
  const headW = 66 + r() * 8, headL = 50 + r() * 6;
  const abdW = 88 + r() * 16, abdL = 150 + r() * 24;
  const eyeR = 0.44 + r() * 0.08;                // eye radius as a fraction of head width
  const wingAngle = 28 + r() * 20;               // degrees off the body axis
  const wingLen = 300 + r() * 40;
  const wingCurl = r();
  const darkFrom = 4 + (r() < 0.5 ? 0 : 1);      // first fully dark tergite (A5 in most males)
  const bandW = 0.28 + r() * 0.18;               // posterior dark band on the pale tergites

  const headY = cy - thoraxL * 0.5 - headL * 0.55;
  const abdY = cy + thoraxL * 0.5 + abdL * 0.46;

  // ---- head: capsule, two compound eyes, three ocelli, antennae with aristae
  const eyeRx = headW * eyeR * 0.55, eyeRy = headL * 0.5;
  let eyes = "";
  for (const side of [-1, 1]) {
    const ex = cx + side * headW * 0.36, ey = headY;
    eyes += `<ellipse cx="${f1(ex)}" cy="${f1(ey)}" rx="${f1(eyeRx)}" ry="${f1(eyeRy)}" fill="${EYE}" stroke="${INK}" stroke-width="1.2"/>`;
    // facets: a stipple that thins toward the highlight
    let dots = "";
    for (let i = 0; i < 160; i++) {
      const a = r() * Math.PI * 2, q = Math.sqrt(r());
      const x = ex + Math.cos(a) * q * eyeRx * 0.9, y = ey + Math.sin(a) * q * eyeRy * 0.9;
      if (x * side > (ex + side * eyeRx * 0.15) * side && y < ey - eyeRy * 0.2 && r() < 0.55) continue;
      dots += `M${P(x, y)}h.01`;
    }
    eyes += `<path d="${dots}" stroke="${EYE_DARK}" stroke-width="1.4" stroke-linecap="round"/>`;
    eyes += `<ellipse cx="${f1(ex + side * eyeRx * 0.25)}" cy="${f1(ey - eyeRy * 0.35)}" rx="${f1(eyeRx * 0.28)}" ry="${f1(eyeRy * 0.2)}" fill="${PAPER}" fill-opacity="0.35"/>`;
  }
  const ocelli = [[0, -0.34], [-0.11, -0.2], [0.11, -0.2]].map(([dx, dy]) =>
    `<circle cx="${f1(cx + dx * headW)}" cy="${f1(headY + dy * headL)}" r="2.6" fill="${EYE}" stroke="${INK}" stroke-width="0.7"/>`).join("");
  const antennae = [-1, 1].map(side => {
    const ax = cx + side * headW * 0.13, ay = headY + headL * 0.34;
    const bx = ax + side * 6, by = ay + 12;
    const arista = `M${P(bx, by)} q${f1(side * 10)},${f1(4 + r() * 8)} ${f1(side * 22)},${f1(2 + r() * 10)}`;
    return `<path d="M${P(ax, ay)} L${P(bx, by)}" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>` +
      `<path d="${arista}" stroke="${INK}" stroke-width="0.9" fill="none"/>` +
      [0.3, 0.55, 0.8].map(t => `<path d="M${P(bx + side * 22 * t, by + 6 * t)} l${f1(side * 2)},-5" stroke="${INK}" stroke-width="0.7"/>`).join("");
  }).join("");
  const head = `<ellipse cx="${cx}" cy="${f1(headY)}" rx="${f1(headW * 0.5)}" ry="${f1(headL * 0.5)}" fill="${CUTICLE}" stroke="${INK}" stroke-width="1.4"/>` +
    eyes + ocelli + antennae;

  // ---- thorax: scutum with the four faint stripes and the bristle rows, then the scutellum
  const tx = cx, ty = cy;
  const scutum = `<ellipse cx="${tx}" cy="${ty}" rx="${f1(thoraxW * 0.5)}" ry="${f1(thoraxL * 0.5)}" fill="${CUTICLE}" stroke="${INK}" stroke-width="1.5"/>`;
  let stripes = "";
  for (const k of [-0.32, -0.11, 0.11, 0.32]) {
    const sx = tx + k * thoraxW;
    stripes += `<path d="M${P(sx, ty - thoraxL * 0.42)} Q${P(sx + k * 6, ty)} ${P(sx, ty + thoraxL * 0.3)}" stroke="${CUTICLE_DARK}" stroke-opacity="0.35" stroke-width="${f1(5 + r() * 3)}" fill="none"/>`;
  }
  // macrochaetae: dorsocentral and acrostichal rows, each bristle a short flick
  let bristles = "";
  const flick = (x: number, y: number, dx: number, dy: number, w: number) =>
    `<path d="M${P(x, y)} q${f1(dx * 0.5)},${f1(dy * 0.5 - 2)} ${f1(dx)},${f1(dy)}" stroke="${INK}" stroke-width="${f1(w)}" stroke-linecap="round" fill="none"/>`;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const y = ty - thoraxL * 0.36 + i * thoraxL * 0.2;
      bristles += flick(tx + side * thoraxW * 0.22, y, side * 4, 13, 1.3);
    }
    for (let i = 0; i < 9; i++) {
      const y = ty - thoraxL * 0.42 + i * thoraxL * 0.09;
      bristles += flick(tx + side * thoraxW * (0.06 + 0.04 * (i % 2)), y, side * 1.5, 6, 0.7);
    }
    // the humeral and notopleural bristles at the shoulder
    bristles += flick(tx + side * thoraxW * 0.46, ty - thoraxL * 0.3, side * 12, 4, 1.4);
    bristles += flick(tx + side * thoraxW * 0.48, ty - thoraxL * 0.1, side * 12, 6, 1.4);
  }
  const scY = ty + thoraxL * 0.5;
  const scutellum = `<path d="M${P(tx - thoraxW * 0.26, scY - 8)} Q${P(tx, scY + 30)} ${P(tx + thoraxW * 0.26, scY - 8)}" fill="${CUTICLE}" stroke="${INK}" stroke-width="1.3"/>` +
    flick(tx - thoraxW * 0.2, scY + 2, -9, 14, 1.4) + flick(tx + thoraxW * 0.2, scY + 2, 9, 14, 1.4) +
    flick(tx - thoraxW * 0.07, scY + 12, -4, 16, 1.4) + flick(tx + thoraxW * 0.07, scY + 12, 4, 16, 1.4);

  // ---- abdomen: six tergites, the last two fully dark in the male
  const NT = 6;
  const tergites: string[] = [];
  const ax = cx, aTop = cy + thoraxL * 0.5 + 4;
  const widthAt = (u: number) => abdW * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.85))) * (u > 0.75 ? 1 - ((u - 0.75) / 0.25) ** 2 * 0.55 : 1);
  const abdOutline: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    abdOutline.push(P(ax + widthAt(u) * 0.5, aTop + u * abdL));
  }
  const abdPath = `M${abdOutline.join(" L")} A${f1(widthAt(1) * 0.5)},8 0 0 1 ${P(ax - widthAt(1) * 0.5, aTop + abdL)} L${abdOutline.slice().reverse().slice(1).map(s => { const [x, y] = s.split(","); return P(2 * ax - Number(x), Number(y)); }).join(" L")} Z`;
  for (let k = 0; k < NT; k++) {
    const u0 = k / NT, u1 = (k + 1) / NT;
    const y0 = aTop + u0 * abdL, y1 = aTop + u1 * abdL;
    const w0 = widthAt(u0) * 0.5, w1 = widthAt(u1) * 0.5;
    const dark = k + 1 >= darkFrom;
    if (dark) {
      tergites.push(`<path d="M${P(ax - w0, y0)} L${P(ax + w0, y0)} L${P(ax + w1, y1)} L${P(ax - w1, y1)} Z" fill="${TERGITE_DARK}" fill-opacity="0.92"/>`);
    } else {
      const yb = y1 - (y1 - y0) * bandW;
      const wb = (w0 + w1) * 0.5;
      tergites.push(`<path d="M${P(ax - wb, yb)} L${P(ax + wb, yb)} L${P(ax + w1, y1)} L${P(ax - w1, y1)} Z" fill="${TERGITE_DARK}" fill-opacity="0.8"/>`);
    }
    tergites.push(`<path d="M${P(ax - w1, y1)} Q${P(ax, y1 + 3)} ${P(ax + w1, y1)}" stroke="${INK}" stroke-opacity="0.6" stroke-width="0.9" fill="none"/>`);
  }
  // fine hairs along the flanks of the pale tergites
  let hairs = "";
  for (let i = 0; i < 90; i++) {
    const u = r() * ((darkFrom - 1) / NT);
    const side = r() < 0.5 ? -1 : 1;
    const x = ax + side * widthAt(u) * 0.5 * (0.55 + r() * 0.4), y = aTop + u * abdL;
    hairs += `M${P(x, y)} l${f1(side * 2)},4`;
  }
  const abdomen = `<path d="${abdPath}" fill="${CUTICLE}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
    tergites.join("") + `<path d="${hairs}" stroke="${INK}" stroke-opacity="0.5" stroke-width="0.7"/>` +
    `<path d="${abdPath}" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>`;

  // ---- legs: six, from under the thorax; fore forward, mid sideways, hind back
  const leg = (side: number, ox: number, oy: number, a1: number, a2: number, a3: number, len: number) => {
    const rad = (d: number) => (d * Math.PI) / 180;
    const p0 = { x: ox, y: oy };
    const p1 = { x: p0.x + Math.cos(rad(a1)) * len * 0.42 * side, y: p0.y + Math.sin(rad(a1)) * len * 0.42 };
    const p2 = { x: p1.x + Math.cos(rad(a2)) * len * 0.38 * side, y: p1.y + Math.sin(rad(a2)) * len * 0.38 };
    const p3 = { x: p2.x + Math.cos(rad(a3)) * len * 0.4 * side, y: p2.y + Math.sin(rad(a3)) * len * 0.4 };
    let s = `<path d="M${P(p0.x, p0.y)} L${P(p1.x, p1.y)}" stroke="${CUTICLE_DARK}" stroke-width="4.2" stroke-linecap="round"/>` +
      `<path d="M${P(p0.x, p0.y)} L${P(p1.x, p1.y)}" stroke="${INK}" stroke-width="1" stroke-linecap="round" fill="none" stroke-opacity="0.9"/>` +
      `<path d="M${P(p1.x, p1.y)} L${P(p2.x, p2.y)}" stroke="${CUTICLE_DARK}" stroke-width="3" stroke-linecap="round"/>` +
      `<path d="M${P(p2.x, p2.y)} L${P(p3.x, p3.y)}" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>`;
    // tarsal segments: five ticks along the last section, the claws at its tip
    for (let t = 1; t <= 4; t++) {
      const x = p2.x + (p3.x - p2.x) * (t / 5), y = p2.y + (p3.y - p2.y) * (t / 5);
      s += `<circle cx="${f1(x)}" cy="${f1(y)}" r="1.3" fill="${INK}"/>`;
    }
    s += `<path d="M${P(p3.x, p3.y)} l${f1(side * 3)},-3 M${P(p3.x, p3.y)} l${f1(side * 3)},2" stroke="${INK}" stroke-width="0.9"/>`;
    return s;
  };
  let legs = "";
  const legLen = thoraxL * 1.05;
  for (const side of [-1, 1]) {
    legs += leg(side, cx + side * thoraxW * 0.3, cy - thoraxL * 0.3, -50 - r() * 15, -25 - r() * 20, 5 + r() * 25, legLen * 0.95);
    legs += leg(side, cx + side * thoraxW * 0.42, cy + thoraxL * 0.02, -5 - r() * 12, 12 + r() * 15, 40 + r() * 20, legLen);
    legs += leg(side, cx + side * thoraxW * 0.36, cy + thoraxL * 0.34, 25 + r() * 15, 45 + r() * 15, 60 + r() * 20, legLen * 1.12);
  }

  // ---- wings: rotate the wing frame back by the spread angle, mirror for the left
  const wings: string[] = [];
  for (const side of [-1, 1]) {
    const bx = cx + side * thoraxW * 0.4, by = cy + thoraxL * 0.12;
    const ang = ((90 + wingAngle) * Math.PI) / 180;
    const T = (x: number, y: number): Pt => {
      const X = x * wingLen, Y = y * wingLen;
      // local +x = along the wing (away from the body), +y = posterior
      return { x: bx + side * (X * Math.sin(ang) * -1 + Y * Math.cos(ang) * -1) * -1, y: by + X * -Math.cos(ang) + Y * Math.sin(ang) };
    };
    const w = wing(T, wingCurl, r);
    wings.push(`<path d="${w.outline}" fill="${WING}" fill-opacity="0.55" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>` +
      `<path d="${w.veins}" stroke="${INK}" stroke-width="1.1" fill="none" stroke-linecap="round"/>` +
      `<path d="${w.outline}" fill="none" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>`);
  }
  // halteres: a stalk and a knob behind each wing base, mostly under the wing
  let halteres = "";
  for (const side of [-1, 1]) {
    const hx = cx + side * thoraxW * 0.46, hy = cy + thoraxL * 0.38;
    const kx = hx + side * 16, ky = hy + 10;
    halteres += `<path d="M${P(hx, hy)} L${P(kx, ky)}" stroke="${INK}" stroke-width="1.4"/><circle cx="${f1(kx)}" cy="${f1(ky)}" r="3.8" fill="${CUTICLE}" stroke="${INK}" stroke-width="1"/>`;
  }

  // ---- cast shadow: hatch lines under the body, offset to the lower right
  let shadow = "";
  for (let y = headY - headL * 0.5; y < abdY + abdL * 0.1; y += 7) {
    const u = (y - aTop) / abdL;
    const w = y < cy - thoraxL * 0.5 ? headW * 0.5 : y < aTop ? thoraxW * 0.5 : widthAt(Math.min(1, Math.max(0, u))) * 0.5;
    shadow += `M${P(cx - w + 10, y + 12)} L${P(cx + w + 10, y + 12)}`;
  }

  // ---- insets: (a) the sex comb on the fore tarsus, (b) the compound eye's facets
  const inset = (x: number, y: number, label: string, body: string) =>
    `<g><circle cx="${x}" cy="${y}" r="96" fill="${PAPER}" stroke="${INK}" stroke-width="0.8"/>` +
    `<clipPath id="c${label}"><circle cx="${x}" cy="${y}" r="95"/></clipPath><g clip-path="url(#c${label})">${body}</g>` +
    `<text x="${x - 96}" y="${y + 122}" fill="${INK}" font-family="${SERIF}" font-style="italic" font-size="15">${label}.</text></g>`;
  const comb = (x: number, y: number) => {
    // the first tarsal segment of the male foreleg, with its row of stout teeth
    const teeth = 9 + Math.floor(r() * 4);
    let s = `<path d="M${P(x - 90, y + 70)} L${P(x - 30, y + 10)}" stroke="${CUTICLE_DARK}" stroke-width="22" stroke-linecap="round"/>` +
      `<path d="M${P(x - 30, y + 10)} L${P(x + 40, y - 50)}" stroke="${CUTICLE}" stroke-width="18" stroke-linecap="round"/>` +
      `<path d="M${P(x - 30, y + 10)} L${P(x + 40, y - 50)}" stroke="${INK}" stroke-width="1.2" stroke-linecap="round" fill="none" stroke-opacity="0.8"/>` +
      `<path d="M${P(x + 40, y - 50)} L${P(x + 80, y - 92)}" stroke="${CUTICLE}" stroke-width="12" stroke-linecap="round"/>`;
    for (let i = 0; i < teeth; i++) {
      const t = 0.15 + (i / teeth) * 0.7;
      const px = x - 30 + 70 * t + 7, py = y + 10 - 60 * t + 7;
      s += `<path d="M${P(px, py)} l${f1(9 + r() * 3)},${f1(7 + r() * 2)}" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>`;
    }
    return s + `<text x="${x - 60}" y="${y + 60}" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="12">${teeth} teeth</text>`;
  };
  const facets = (x: number, y: number) => {
    let s = `<circle cx="${x}" cy="${y}" r="96" fill="${EYE}"/>`;
    const R = 9;
    for (let row = -8; row <= 8; row++) {
      for (let col = -8; col <= 8; col++) {
        const hx = x + col * R * 1.75 + (row % 2 ? R * 0.875 : 0), hy = y + row * R * 1.5;
        if (Math.hypot(hx - x, hy - y) > 100) continue;
        const pts: string[] = [];
        for (let k = 0; k < 6; k++) pts.push(P(hx + R * Math.cos((k * Math.PI) / 3 + Math.PI / 6), hy + R * Math.sin((k * Math.PI) / 3 + Math.PI / 6)));
        s += `<path d="M${pts.join(" L")} Z" fill="${EYE}" stroke="${EYE_DARK}" stroke-width="1.2"/>`;
        s += `<circle cx="${f1(hx - 2)}" cy="${f1(hy - 2.5)}" r="2" fill="${PAPER}" fill-opacity="0.3"/>`;
      }
    }
    // the interommatidial bristles, one between each pair of facets
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2, q = r() * 85;
      s += `<path d="M${P(x + Math.cos(a) * q, y + Math.sin(a) * q)} l2,-5" stroke="${INK}" stroke-width="0.9"/>`;
    }
    return s;
  };

  // ---- captions
  const short = hex.length > 16 ? `\u2026${hex.slice(-16)}` : hex || "0";
  const title = `Instar fly #${p.id} \u00b7 generation ${p.generation}`;
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
    `<text x="${W - 70}" y="88" text-anchor="end" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="17">Drosophila melanogaster, adult male, dorsal</text>` +
    `<line x1="70" y1="104" x2="${W - 70}" y2="104" stroke="${RULE}" stroke-width="0.8"/>` +
    // the animal, in drawing order: shadow, legs and halteres under the body, body, wings over the abdomen
    `<g transform="rotate(${f1(tilt)} ${cx} ${cy})">` +
    `<path d="${shadow}" stroke="${INK}" stroke-opacity="0.16" stroke-width="1"/>` +
    legs + halteres + abdomen + scutum + stripes + bristles + scutellum + head + wings.join("") +
    `</g>` +
    // labels with leader lines
    `<path d="M${P(cx - headW * 0.36 - 20, headY - 10)} L150,${f1(headY - 60)}" stroke="${INK2}" stroke-width="0.7" fill="none"/>` +
    `<text x="150" y="${f1(headY - 66)}" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="15">compound eye</text>` +
    `<path d="M${P(cx + thoraxW * 0.5 + 12, cy + thoraxL * 0.42)} L${W - 150},${f1(cy + thoraxL * 0.9)}" stroke="${INK2}" stroke-width="0.7" fill="none"/>` +
    `<text x="${W - 150}" y="${f1(cy + thoraxL * 0.9 + 18)}" text-anchor="end" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="15">haltere</text>` +
    `<path d="M${P(cx + 8, aTop + abdL * 0.9)} L${W - 150},${f1(aTop + abdL * 0.98)}" stroke="${INK2}" stroke-width="0.7" fill="none"/>` +
    `<text x="${W - 150}" y="${f1(aTop + abdL * 0.98 + 18)}" text-anchor="end" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="15">tergites A5\u2013A6, dark in the male</text>` +
    // insets
    inset(196, 760, "a", comb(196, 760)) + inset(W - 196, 760, "b", facets(W - 196, 760)) +
    // scale bar: nominal, an adult male is about two and a half millimetres long
    `<path d="M${cx - 120},690 v6 M${cx - 120},693 h240 M${cx + 120},690 v6" stroke="${INK}" stroke-width="1" fill="none"/>` +
    `<text x="${cx}" y="712" text-anchor="middle" fill="${INK2}" font-family="${MONO}" font-size="11">1 mm, nominal</text>` +
    // caption
    `<line x1="70" y1="${H - 104}" x2="${W - 70}" y2="${H - 104}" stroke="${RULE}" stroke-width="0.8"/>` +
    `<text x="70" y="${H - 72}" fill="${INK}" font-family="${SERIF}" font-size="26">${esc(title)}</text>` +
    `<text x="70" y="${H - 50}" fill="${INK2}" font-family="${MONO}" font-size="11.5">genome ${esc(short)} \u00b7 ${esc(p.status)} \u00b7 a. sex comb, fore tarsus \u00b7 b. compound eye, facets</text>` +
    `<text x="${W - 70}" y="${H - 72}" text-anchor="end" fill="${INK2}" font-family="${SERIF}" font-style="italic" font-size="15">after Berg et al. 2026 (Janelia MaleCNS)</text>` +
    `</svg>`;
}
