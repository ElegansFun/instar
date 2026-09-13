// Force-directed map of the whole census: 2,952 nodes, every edge used for the
// layout, coloured by the role the engine gives each node. 2D canvas; the
// repulsion is bucketed on a grid so the layout settles in a few seconds
// rather than a few minutes.
import { ROLE_NAME } from "./roles.js";

export const ROLE_COLOR = {
  0: "#BDB5A5",
  1: "#C98A2B", 2: "#A86A1E", 3: "#7E4A14",
  4: "#5E7B3A", 5: "#9B2F1B", 6: "#3D7F8A", 7: "#D45B2C",
  8: "#C9A227", 9: "#8A9A3A", 10: "#6C4C2B", 11: "#4C8A8A",
  20: "#1F6F5A", 21: "#2F8F74", 22: "#164E40", 23: "#141311", 24: "#B0603F",
};
export const ROLE_ORDER = [1, 2, 3, 6, 7, 8, 10, 11, 4, 5, 9, 20, 21, 22, 23, 24, 0];

export function mountBrainMap({ canvas, census, roles, legend, tip, tools, edgesEl }) {
  const ctx = canvas.getContext("2d");
  const N = census.nodes.length;
  const index = new Map(census.nodes.map((n, i) => [n.id, i]));
  const E = census.edges.length;
  const ea = new Int32Array(E), eb = new Int32Array(E), ew = new Float32Array(E);
  const deg = new Int32Array(N), indeg = new Int32Array(N), outdeg = new Int32Array(N);
  for (let k = 0; k < E; k++) {
    const e = census.edges[k];
    ea[k] = index.get(e.pre); eb[k] = index.get(e.post); ew[k] = e.weight;
    outdeg[ea[k]]++; indeg[eb[k]]++;
    if (ea[k] !== eb[k]) { deg[ea[k]]++; deg[eb[k]]++; }
  }
  const adj = Array.from({ length: N }, () => []);
  for (let k = 0; k < E; k++) if (ea[k] !== eb[k]) { adj[ea[k]].push(k); adj[eb[k]].push(k); }

  const px = new Float32Array(N), py = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
  const state = { alpha: 1, steps: 0, settled: false, hover: -1, pinned: -1, minW: 5, drag: null, zoom: 1, ox: 0, oy: 0 };
  const layoutR = () => Math.min(canvas.clientWidth, canvas.clientHeight) * 0.46;

  function seed() {
    // roles start in bands so the settled map keeps sensory at the top and
    // descending output at the bottom, which is the anatomy a reader expects
    const R = layoutR();
    for (let i = 0; i < N; i++) {
      const r = roles[i];
      const band = r >= 1 && r <= 11 ? -0.55 : r >= 20 ? 0.55 : 0;
      const a = i * 2.399963;              // golden angle scatter
      const rad = R * (0.15 + 0.85 * Math.sqrt((i % 211) / 211));
      px[i] = Math.cos(a) * rad;
      py[i] = Math.sin(a) * rad * 0.6 + band * R;
      vx[i] = vy[i] = 0;
    }
    state.alpha = 1; state.steps = 0; state.settled = false;
  }

  // grid-bucketed repulsion: each node only sees the nodes within a cutoff
  const CUT = 22;
  let cellsX = 0, cellsY = 0, cellHead = null, cellNext = new Int32Array(N);
  function step() {
    const rep = 300, springK = 0.008, gravity = 0.06, damp = 0.68;
    const R = layoutR();
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < N; i++) { if (px[i] < minx) minx = px[i]; if (px[i] > maxx) maxx = px[i]; if (py[i] < miny) miny = py[i]; if (py[i] > maxy) maxy = py[i]; }
    cellsX = Math.max(1, Math.ceil((maxx - minx) / CUT) + 1);
    cellsY = Math.max(1, Math.ceil((maxy - miny) / CUT) + 1);
    if (!cellHead || cellHead.length < cellsX * cellsY) cellHead = new Int32Array(cellsX * cellsY);
    cellHead.fill(-1);
    for (let i = 0; i < N; i++) {
      const c = Math.floor((py[i] - miny) / CUT) * cellsX + Math.floor((px[i] - minx) / CUT);
      cellNext[i] = cellHead[c]; cellHead[c] = i;
    }
    for (let i = 0; i < N; i++) {
      const cx = Math.floor((px[i] - minx) / CUT), cy = Math.floor((py[i] - miny) / CUT);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= cellsX || gy >= cellsY) continue;
        for (let j = cellHead[gy * cellsX + gx]; j >= 0; j = cellNext[j]) {
          if (j <= i) continue;
          let ddx = px[i] - px[j], ddy = py[i] - py[j];
          let d2 = ddx * ddx + ddy * ddy;
          if (d2 > CUT * CUT) continue;
          if (d2 < 0.5) { d2 = 0.5; ddx = (i & 1) ? 0.5 : -0.5; ddy = (j & 1) ? 0.5 : -0.5; }
          const f = rep / d2;
          const d = Math.sqrt(d2);
          const fx = ddx / d * f, fy = ddy / d * f;
          vx[i] += fx; vy[i] += fy; vx[j] -= fx; vy[j] -= fy;
        }
      }
    }
    for (let k = 0; k < E; k++) {
      const a = ea[k], b = eb[k];
      if (a === b) continue;
      let dx = px[b] - px[a], dy = py[b] - py[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = springK * (d - 10) * Math.min(1.2, 0.35 + ew[k] * 0.08) / Math.sqrt(1 + deg[a] * 0.02 + deg[b] * 0.02);
      dx /= d; dy /= d;
      vx[a] += dx * f; vy[a] += dy * f; vx[b] -= dx * f; vy[b] -= dy * f;
    }
    for (let i = 0; i < N; i++) {
      vx[i] -= px[i] * gravity; vy[i] -= py[i] * gravity * 1.3;
      vx[i] *= damp; vy[i] *= damp;
      px[i] += vx[i] * state.alpha; py[i] += vy[i] * state.alpha;
    }
    if (state.alpha > 0.04) state.alpha *= 0.992;
    if (++state.steps > 520) state.settled = true;
  }

  const roleCount = new Map();
  for (let i = 0; i < N; i++) roleCount.set(roles[i], (roleCount.get(roles[i]) || 0) + 1);
  if (legend) {
    legend.innerHTML = ROLE_ORDER.filter(r => roleCount.get(r)).map(r =>
      `<tr><td><span class="sw" style="background:${ROLE_COLOR[r]}"></span>${ROLE_NAME[r]}</td><td class="n">${roleCount.get(r).toLocaleString("en-US")}</td></tr>`
    ).join("") + `<tr class="total"><td>all nodes</td><td class="n">${N.toLocaleString("en-US")}</td></tr>`;
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#F3EEE3";
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + state.ox, h / 2 + state.oy);
    ctx.scale(state.zoom, state.zoom);
    const focus = state.pinned >= 0 ? state.pinned : state.hover;
    // edges, bucketed by alpha so the whole map is a handful of stroke calls
    const buckets = new Map();
    let drawn = 0;
    for (let k = 0; k < E; k++) {
      if (ea[k] === eb[k] || ew[k] < state.minW) continue;
      if (focus >= 0 && (ea[k] === focus || eb[k] === focus)) continue;
      const alpha = focus >= 0 ? 0.02 : Math.min(0.16, 0.02 + ew[k] * 0.006);
      const key = alpha.toFixed(2);
      let p = buckets.get(key); if (!p) buckets.set(key, (p = new Path2D()));
      p.moveTo(px[ea[k]], py[ea[k]]); p.lineTo(px[eb[k]], py[eb[k]]);
      drawn++;
    }
    ctx.lineWidth = 0.5 / state.zoom;
    ctx.strokeStyle = "#141311";
    for (const [key, p] of buckets) { ctx.globalAlpha = +key; ctx.stroke(p); }
    if (focus >= 0) {
      ctx.lineWidth = 0.9 / state.zoom;
      for (const k of adj[focus]) {
        const out = ea[k] === focus;
        ctx.globalAlpha = Math.min(0.9, 0.3 + ew[k] * 0.06);
        ctx.strokeStyle = out ? "#C98A2B" : "#2B5F8C";
        ctx.beginPath(); ctx.moveTo(px[ea[k]], py[ea[k]]); ctx.lineTo(px[eb[k]], py[eb[k]]); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // nodes, grouped by colour
    const byRole = new Map();
    for (let i = 0; i < N; i++) { const r = roles[i]; let a = byRole.get(r); if (!a) byRole.set(r, (a = [])); a.push(i); }
    const s = 1.9 / Math.sqrt(state.zoom);
    for (const [r, list] of byRole) {
      ctx.fillStyle = ROLE_COLOR[r];
      const p = new Path2D();
      for (const i of list) { const rr = r === 0 ? s : s * 1.5; p.moveTo(px[i] + rr, py[i]); p.arc(px[i], py[i], rr, 0, Math.PI * 2); }
      ctx.fill(p);
    }
    if (focus >= 0) {
      ctx.strokeStyle = "#141311"; ctx.lineWidth = 1 / state.zoom;
      ctx.beginPath(); ctx.arc(px[focus], py[focus], 5 / state.zoom, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    if (edgesEl) edgesEl.textContent = `${drawn.toLocaleString("en-US")} edges drawn (w \u2265 ${state.minW})`;
  }

  function nodeAt(mx, my) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const x = (mx - w / 2 - state.ox) / state.zoom, y = (my - h / 2 - state.oy) / state.zoom;
    let best = -1, bd = 7 / state.zoom;
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(px[i] - x, py[i] - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function describe(i) {
    const n = census.nodes[i];
    const parts = [`<b>${n.id}</b>`, n.source_type || "unannotated", n.category || "", ROLE_NAME[roles[i]] || "", `${indeg[i]} in / ${outdeg[i]} out`];
    return parts.filter(Boolean).join(" \u00b7 ");
  }
  let needDraw = true;
  canvas.addEventListener("pointermove", (ev) => {
    const r = canvas.getBoundingClientRect();
    if (state.drag) {
      state.ox = state.drag.ox + (ev.clientX - state.drag.x);
      state.oy = state.drag.oy + (ev.clientY - state.drag.y);
      needDraw = true;
      return;
    }
    const i = nodeAt(ev.clientX - r.left, ev.clientY - r.top);
    if (i !== state.hover) { state.hover = i; needDraw = true; }
    if (tip) {
      if (i >= 0) { tip.style.display = "block"; tip.style.left = (ev.clientX - r.left + 12) + "px"; tip.style.top = (ev.clientY - r.top + 12) + "px"; tip.innerHTML = describe(i); }
      else tip.style.display = "none";
    }
  });
  canvas.addEventListener("pointerleave", () => { state.hover = -1; if (tip) tip.style.display = "none"; needDraw = true; });
  canvas.addEventListener("pointerdown", (ev) => { state.drag = { x: ev.clientX, y: ev.clientY, ox: state.ox, oy: state.oy, moved: false }; });
  window.addEventListener("pointerup", (ev) => {
    if (!state.drag) return;
    const moved = Math.hypot(ev.clientX - state.drag.x, ev.clientY - state.drag.y) > 4;
    state.drag = null;
    if (!moved) {
      const r = canvas.getBoundingClientRect();
      const i = nodeAt(ev.clientX - r.left, ev.clientY - r.top);
      state.pinned = i === state.pinned ? -1 : i;
      needDraw = true;
    }
  });
  canvas.addEventListener("wheel", (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return; // plain wheel scrolls the page
    ev.preventDefault();
    state.zoom = Math.max(0.5, Math.min(6, state.zoom * (ev.deltaY < 0 ? 1.12 : 0.89)));
    needDraw = true;
  }, { passive: false });
  if (tools) {
    tools.querySelectorAll("[data-minw]").forEach(b => b.addEventListener("click", () => {
      state.minW = +b.dataset.minw;
      tools.querySelectorAll("[data-minw]").forEach(x => x.classList.toggle("on", x === b));
      needDraw = true;
    }));
    tools.querySelector("[data-relayout]")?.addEventListener("click", () => { seed(); needDraw = true; });
  }

  seed();
  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);
  function loop() {
    if (visible) {
      if (!state.settled) { for (let k = 0; k < 6; k++) step(); needDraw = true; }
      if (needDraw) { draw(); needDraw = false; }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  new ResizeObserver(() => { needDraw = true; }).observe(canvas);
  return { state, relayout: seed, step, draw };
}
