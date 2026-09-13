// The brain panel: per-group firing bars from the stream's counts, and a
// dot raster of one fly's neurons sampled every Nth node in canonical order,
// fetched from /api/fly/:id/fired while the panel is open. 166,700 neurons
// are too many for one dot each at a readable size, so the raster is a
// sample and says so in its caption.
import { API } from "./engine.js";
import { ROLE_LABEL } from "./roles.js";

export const GROUP_LABEL = {
  any: "all neurons", sens: "sensory", dn: "descending", legL: "leg MNs, left", legR: "leg MNs, right",
  wingP: "wing power MNs", wingS: "wing steering MNs", haltere: "haltere MNs", prob: "proboscis MNs",
  neuro: "neurosecretory", an: "ascending", other: "everything else",
};
export const GROUP_COLOR = {
  any: "#141311", sens: "#C98A2B", dn: "#1F6F5A", legL: "#5E7B3A", legR: "#8A9A3A", wingP: "#3D7F8A", wingS: "#4C8A8A",
  haltere: "#6C4C2B", prob: "#9B2F1B", neuro: "#B0603F", an: "#2F8F74", other: "#BDB5A5",
};
const RASTER_W = 512, RASTER_H = 326, DOT = 2, STRIDE = 4;
const POLL_MS = 250;

// group -> number of neurons it sums, from the config's role counts
export function groupSizes(config) {
  const sizes = {};
  const rc = config.roleCounts || {};
  const total = Object.values(rc).reduce((a, n) => a + n, 0);
  for (const [g, roles] of Object.entries(config.groups || {})) sizes[g] = roles.reduce((a, r) => a + (rc[r] || 0), 0);
  if (config.groups && config.groups.any === undefined) sizes.any = total;
  return sizes;
}
// rows for a role table: [id, label, count], assigned roles first, by id
export function roleRows(config) {
  const rc = config.roleCounts || {};
  return Object.keys(rc).map(Number).sort((a, b) => a - b).map(r => [r, ROLE_LABEL[r] || `role ${r}`, rc[r]]);
}

export function mountBrainPanel({ bars, raster, config }) {
  const groups = Object.keys(config.groups || {}).filter(g => g !== "other");
  if (!groups.includes("any")) groups.unshift("any");
  const sizes = groupSizes(config);
  const nodes = config.nodes || 0;
  const bctx = bars.getContext("2d", { alpha: false });
  const rctx = raster.getContext("2d", { alpha: false });
  raster.width = RASTER_W; raster.height = RASTER_H;
  const ROW = 15;
  bars.width = 480; bars.height = groups.length * ROW + 4;
  // the bar scale: fired as a fraction of the group, on a log-ish scale so
  // one firing in a 24-cell group and 900 in 12,000 both show
  const frac = (n, size) => size ? Math.min(1, Math.log1p(n) / Math.log1p(size)) : 0;
  let lastFired = null;
  function drawBars(fired) {
    lastFired = fired;
    const W = bars.width;
    bctx.fillStyle = "#F3EEE3"; bctx.fillRect(0, 0, W, bars.height);
    bctx.font = "10px 'IBM Plex Mono', monospace"; bctx.textBaseline = "middle";
    groups.forEach((g, i) => {
      const y = i * ROW + 2;
      const n = fired ? (fired[g] ?? 0) : 0, size = sizes[g] || 0;
      bctx.fillStyle = "#5c574c";
      bctx.fillText(GROUP_LABEL[g] || g, 2, y + ROW / 2);
      const x0 = 130, x1 = W - 92;
      bctx.fillStyle = "#e4dccb"; bctx.fillRect(x0, y + 3, x1 - x0, ROW - 6);
      bctx.fillStyle = GROUP_COLOR[g] || "#141311";
      bctx.fillRect(x0, y + 3, Math.round((x1 - x0) * frac(n, size)), ROW - 6);
      bctx.fillStyle = "#141311"; bctx.textAlign = "right";
      bctx.fillText(fired ? `${n.toLocaleString("en-US")} / ${size.toLocaleString("en-US")}` : `\u2014 / ${size.toLocaleString("en-US")}`, W - 2, y + ROW / 2);
      bctx.textAlign = "left";
    });
  }
  function clearRaster() {
    rctx.fillStyle = "#F3EEE3"; rctx.fillRect(0, 0, RASTER_W, RASTER_H);
  }
  function drawRaster(bits) {
    clearRaster();
    rctx.fillStyle = "#141311";
    const cols = RASTER_W / DOT;
    const n = Math.ceil(nodes / STRIDE);
    let lit = 0;
    for (let k = 0; k < n; k++) {
      if (!(bits[k >> 3] & (1 << (k & 7)))) continue;
      lit++;
      rctx.fillRect((k % cols) * DOT, Math.floor(k / cols) * DOT, DOT, DOT);
    }
    return { lit, sampled: n };
  }
  drawBars(null); clearRaster();

  // polling the bitmap for the watched fly, only while asked
  let watching = -1, timer = 0, busy = false, onRaster = () => {};
  async function tickPoll() {
    if (watching < 0 || busy) return;
    busy = true;
    try {
      const r = await fetch(`${API}/api/fly/${watching}/fired?stride=${STRIDE}`, { cache: "no-store" });
      if (r.ok) { const bits = new Uint8Array(await r.arrayBuffer()); onRaster(drawRaster(bits), null); }
      else onRaster(null, r.status === 404 ? "this fly is not alive" : `fired bitmap: ${r.status}`);
    } catch (e) { onRaster(null, e.message); }
    finally { busy = false; }
  }
  return {
    stride: STRIDE, dot: DOT, sampled: Math.ceil(nodes / STRIDE), nodes, groups, sizes,
    bars: drawBars,
    watch(id, cb) {
      onRaster = cb || (() => {});
      if (id === watching) return;
      watching = id;
      clearInterval(timer); timer = 0;
      if (id >= 0) { tickPoll(); timer = setInterval(tickPoll, POLL_MS); }
      else { clearRaster(); drawBars(null); }
    },
    redraw() { drawBars(lastFired); },
  };
}
